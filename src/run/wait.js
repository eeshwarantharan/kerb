// kerb wait-for (4.7.8): fold a polling loop into one call.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, UsageError, newId, now, parseDuration, formatDuration } from '../util/core.js';
import { ensureDir } from '../util/fsx.js';
import { relPath } from '../util/repo.js';
import { Shaper } from './shape.js';
import { redactText } from './redact.js';
import { supervise, markActive, clearActive, SIGNUMS } from './supervisor.js';
import { Analyzer, compilePatterns } from '../loop/fingerprint.js';

export const MAX_WAIT_MS = 30 * 60_000;
const BACKOFF_CAP_MS = 60_000;

/**
 * Parse and validate wait-for options.
 * @param {{ until?: string, interval?: string, max?: string, backoff?: boolean }} opts
 * @param {number | null} agentTimeoutMs
 */
export function waitOptions(opts, agentTimeoutMs = null) {
  const intervalMs = parseDuration(opts.interval || '5s');
  if (intervalMs < 1000) throw new UsageError('--interval must be at least 1s');
  let maxMs = parseDuration(opts.max || '3m');
  if (maxMs > MAX_WAIT_MS) throw new UsageError('--max must be at most 30m');
  if (maxMs <= 0) throw new UsageError('--max must be positive');
  let capped = false;
  if (agentTimeoutMs) {
    const cap = Math.max(1000, agentTimeoutMs - 10_000);
    if (maxMs > cap) { maxMs = cap; capped = true; }
  }
  const until = opts.until || 'success';
  /** @type {{ kind: 'success' } | { kind: 'exit', code: number } | { kind: 'output', re: RegExp }} */
  let cond;
  if (until === 'success') cond = { kind: 'success' };
  else if (until.startsWith('exit:')) {
    const code = Number(until.slice(5));
    if (!Number.isInteger(code) || code < 0 || code > 255) throw new UsageError('--until exit:<n> needs a number from 0 to 255');
    cond = { kind: 'exit', code };
  } else if (until.startsWith('output:')) {
    const src = until.slice(7);
    if (!src || src.length > 200) throw new UsageError('--until output:<regex> needs a regex of at most 200 characters');
    try { cond = { kind: 'output', re: new RegExp(src) }; } catch (e) { throw new UsageError(`invalid --until regex: ${e.message}`); }
  } else throw new UsageError('--until must be success, exit:<n> or output:<regex>');
  return { intervalMs, maxMs, capped, cond, backoff: !!opts.backoff };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.onAbort = () => { clearTimeout(t); resolve(); };
  });
}

/**
 * Run the polling loop.
 * @param {any} prep engine prep
 * @param {ReturnType<typeof waitOptions> & { idleMs: number, budget: number, loop?: any }} w
 */
export async function waitFor(prep, w) {
  const { ctx, store } = prep;
  store.ensure();
  const id = newId();
  const startTs = now();
  const t0 = Date.now();
  const deadline = t0 + w.maxMs;
  const logDir = ensureDir(path.join(store.dir, 'logs'));
  const logPath = path.join(logDir, `${id}.log`);
  const logRel = relPath(prep.root, logPath);
  let attempts = 0;
  let last = null;
  let met = false;
  let aborted = null;
  let rawTotal = 0;
  let interval = w.intervalMs;
  let current = null;
  const sleeper = {};
  const handlers = {};
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    handlers[sig] = () => {
      aborted = sig;
      if (current) current.abort(sig);
      if (sleeper.onAbort) sleeper.onAbort();
    };
    process.on(sig, handlers[sig]);
  }

  try {
    while (!aborted) {
      attempts++;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { attempts--; break; }
      fs.appendFileSync(logPath, `[kerb] attempt ${attempts}\n`, { mode: 0o600 });
      let matched = false;
      const analyzer = new Analyzer({ transient: compilePatterns(prep.policy.transient_patterns), dependency: compilePatterns(prep.policy.dependency_patterns) });
      const shaper = new Shaper({
        budget: w.budget,
        logPath,
        onLine: (line) => {
          analyzer.line(line);
          if (w.cond.kind === 'output' && line.length <= 4096 && w.cond.re.test(line)) matched = true;
        },
      });
      shaper.logPath = logRel;
      current = supervise(prep.command, {
        cwd: ctx.cwd,
        env: ctx.env,
        timeoutMs: remaining,
        idleMs: w.idleMs,
        onData: (d) => shaper.push(d),
        onSpawn: ({ pgid }) => markActive(store, { id, kerb_pid: process.pid, pgid, key: prep.key, class: prep.cls, pre_hash: w.loop ? w.loop.preHash : null, ts: startTs, session: prep.session }),
      });
      const res = await current.done;
      current = null;
      const shaped = shaper.end();
      rawTotal += shaped.rawBytes;
      let exit;
      if (res.reason === 'timeout') exit = EXIT.TIMEOUT;
      else if (res.reason === 'idle') exit = EXIT.IDLE;
      else if (res.reason === 'aborted') exit = 128 + (SIGNUMS[res.abortSignal] || 15);
      else exit = res.exit ?? 128 + (SIGNUMS[res.signal] || 1);
      last = { res, shaped, exit, analysis: analyzer.result({ timedOut: res.reason === 'timeout' || res.reason === 'idle' }) };
      if (res.reason === 'aborted') break;
      if (w.cond.kind === 'success') met = exit === 0;
      else if (w.cond.kind === 'exit') met = exit === w.cond.code;
      else met = matched;
      if (met) break;
      const jitter = interval * (0.9 + Math.random() * 0.2);
      if (Date.now() + jitter >= deadline) break;
      await sleep(jitter, sleeper);
      if (w.backoff) interval = Math.min(interval * 2, BACKOFF_CAP_MS);
    }
  } finally {
    for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
    clearActive(store, id);
  }

  const duration = Date.now() - t0;
  const finalExit = last ? last.exit : null;
  let classResult;
  if (aborted || (last && last.res.reason === 'aborted')) classResult = 'aborted';
  else if (!last) classResult = 'failure';
  else if (last.res.reason === 'timeout') classResult = 'timeout';
  else if (last.res.reason === 'idle') classResult = 'idle';
  else classResult = finalExit === 0 ? 'ok' : 'failure';
  let postHash = null;
  if (w.loop && w.loop.postHash && !w.loop.skipped) postHash = w.loop.postHash(id).hash;
  const result = aborted ? 'aborted' : met ? 'met' : 'gave_up';
  const rec = {
    type: 'wait',
    id,
    ts: now(),
    start_ts: startTs,
    key: prep.key,
    class: prep.cls,
    cmd: redactText(prep.command),
    attempts,
    duration_ms: duration,
    result,
    final_exit: finalExit,
    exit: finalExit,
    class_result: classResult,
    failure_kind: classResult === 'failure' || classResult === 'timeout' || classResult === 'idle' ? (last ? last.analysis.kind : 'ordinary') : null,
    fingerprint: last ? last.analysis.fingerprint : null,
    first_fail_line: last && finalExit !== 0 ? redactText(last.analysis.firstFailLine) : null,
    pre_hash: w.loop ? w.loop.preHash : null,
    post_hash: postHash,
    env_stamp: w.loop ? w.loop.envStamp : null,
    raw_bytes: rawTotal,
    shown_bytes: last ? last.shaped.shownBytes : 0,
    agent: prep.agent,
    tier: prep.tier,
    session: prep.session,
    log: logRel,
  };
  store.append([rec]);
  let exit;
  if (aborted) exit = 128 + (SIGNUMS[aborted] || 15);
  else exit = met ? 0 : EXIT.TIMEOUT;
  const summary = met
    ? `kerb: wait-for · condition met after ${attempts} attempt${attempts === 1 ? '' : 's'} in ${formatDuration(duration)}`
    : aborted
      ? `kerb: wait-for · stopped by ${aborted} after ${attempts} attempt${attempts === 1 ? '' : 's'}`
      : `kerb: wait-for · gave up after ${attempts} attempt${attempts === 1 ? '' : 's'} in ${formatDuration(duration)}; last output above`;
  return { rec, exit, summary, output: last ? last.shaped.text : '', logRel };
}
