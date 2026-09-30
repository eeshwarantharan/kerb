// The supervised runner: spawn, shape, analyse, learn, record, print. Loaded only when a
// command actually runs, so pre-checks and hooks stay fast.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, newId, now, formatBytes, formatDuration } from '../util/core.js';
import { ensureDir } from '../util/fsx.js';
import { relPath } from '../util/repo.js';
import { DenialScanner, isNetworkCapable, recordDenial } from '../bound/learn.js';
import { commandHosts } from '../parse/hosts.js';
import { Analyzer, compilePatterns } from '../loop/fingerprint.js';
import { Shaper } from './shape.js';
import { redactText } from './redact.js';
import { supervise, markActive, clearActive, activeRuns, passthrough, SIGNUMS } from './supervisor.js';
import { formatNote, paint } from '../ui/format.js';
import { regenerateBriefing } from '../init/instructions.js';
import { summaryTweak, startRecord } from '../engine.js';

/**
 * Background commands: pre-check only, then run with the agent's normal behaviour.
 */
export async function runBackground(prep) {
  const id = newId();
  const start = startRecord(prep, id, { pgid: null });
  const code = await passthrough(prep.command, { cwd: prep.ctx.cwd, env: prep.ctx.env });
  prep.store.ensure().append([start, {
    type: 'end', id, ts: now(), exit: null, signal: null, duration_ms: now() - start.ts, post_hash: null,
    fingerprint: null, failure_kind: null, class_result: 'ok', raw_bytes: 0, shown_bytes: 0, first_fail_line: null,
    loop_skipped: null, key: prep.key, class: 'background', session: prep.session,
  }]);
  return code;
}

/**
 * Run supervised, shaping output and recording start/end.
 * @param {any} prep
 * @param {{ timeoutMs: number, idleMs: number, budget: number, loop?: any, notes?: string[],
 *   hosts?: string[], quiet?: boolean, logSuffix?: string, onAttemptLine?: (l: string) => void, handleSignals?: boolean }} o
 */
export async function runSupervised(prep, o) {
  const { ctx, store } = prep;
  store.ensure();
  const id = newId();
  const logDir = ensureDir(path.join(store.dir, 'logs'));
  const logPath = path.join(logDir, `${id}.log`);
  const logRel = relPath(prep.root, logPath);
  const analyzer = new Analyzer({
    transient: compilePatterns(prep.policy.transient_patterns),
    dependency: compilePatterns(prep.policy.dependency_patterns),
  });
  const denials = new DenialScanner();
  const fixes = (prep.policy.fixes || []).filter((f) => !f.key_contains || prep.key.includes(f.key_contains));
  const fixHits = new Set();
  const shaper = new Shaper({
    budget: o.budget,
    logPath,
    onLine: (line) => {
      analyzer.line(line);
      denials.line(line);
      fixes.forEach((f, i) => { if (f.output_contains && line.includes(f.output_contains)) fixHits.add(i); });
      if (o.onAttemptLine) o.onAttemptLine(line);
    },
  });
  shaper.logPath = logRel;
  const notes = [...(o.notes || [])];
  const loop = o.loop || null;

  // Concurrent runs of the same key are allowed; say so once.
  const same = activeRuns(store).find((a) => a.key === prep.key && a.pre_hash === (loop ? loop.preHash : null));
  if (same) notes.push(`the same command is already running as ${same.id}`);

  let startRec = null;
  const sup = supervise(prep.command, {
    cwd: ctx.cwd,
    env: ctx.env,
    timeoutMs: o.timeoutMs,
    idleMs: o.idleMs,
    onData: (d) => shaper.push(d),
    onSpawn: ({ pgid }) => {
      startRec = startRecord(prep, id, { pgid, scope: loop ? loop.scope : null, pre_hash: loop ? loop.preHash : null, env_stamp: loop ? loop.envStamp : null });
      store.append([startRec]);
      markActive(store, { id, kerb_pid: process.pid, pgid, key: prep.key, class: prep.cls, pre_hash: loop ? loop.preHash : null, ts: startRec.ts, session: prep.session });
    },
  });

  const handlers = {};
  if (o.handleSignals !== false) {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      handlers[sig] = () => sup.abort(sig);
      process.on(sig, handlers[sig]);
    }
  }
  const res = await sup.done;
  for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);

  const shaped = shaper.end();
  const timedOut = res.reason === 'timeout' || res.reason === 'idle';
  const analysis = analyzer.result({ timedOut });

  let exit;
  if (res.reason === 'timeout') exit = EXIT.TIMEOUT;
  else if (res.reason === 'idle') exit = EXIT.IDLE;
  else if (res.reason === 'aborted') exit = 128 + (SIGNUMS[res.abortSignal] || 15);
  else if (res.exit != null) exit = res.exit;
  else exit = 128 + (SIGNUMS[res.signal] || 1);

  /** @type {string} */
  let classResult;
  if (res.reason === 'timeout') classResult = 'timeout';
  else if (res.reason === 'idle') classResult = 'idle';
  else if (res.reason === 'aborted') classResult = 'aborted';
  else classResult = exit === 0 ? 'ok' : 'failure';

  // Learn from real policy denials (4.8.5).
  let learned = null;
  const extraRecs = [];
  if (exit !== 0 && res.reason !== 'aborted') {
    const hosts = o.hosts || commandHosts(prep.parsed, { env: ctx.env }).map((h) => h.host);
    const denial = denials.resolve(hosts, isNetworkCapable(prep.parsed, hosts));
    if (denial) {
      learned = recordDenial({ host: denial.host, strength: denial.strength, key: prep.key, runId: id, nowTs: now() });
      classResult = 'policy_denial';
      extraRecs.push({ type: 'learn', id: newId(), ts: now(), host: denial.host, status: learned.entry.status, run: id, session: prep.session, new: learned.becameConfirmed });
      if (learned.entry.status === 'confirmed') notes.push(`recorded a policy block for ${denial.host}; it will be refused before running next time`);
      else notes.push(`${denial.host} may be blocked here (seen ${learned.entry.hits} time${learned.entry.hits === 1 ? '' : 's'})`);
    }
  }

  let postHash = null;
  let loopSkipped = loop ? loop.skipped || null : null;
  if (loop && loop.postHash && !loop.skipped) {
    const post = loop.postHash(id);
    postHash = post.hash;
    if (post.skipped) loopSkipped = post.skipped;
  }

  const failureKind = classResult === 'failure' || classResult === 'timeout' || classResult === 'idle'
    ? (timedOut ? 'transient' : analysis.kind) : null;
  const endRec = {
    type: 'end',
    id,
    ts: now(),
    exit,
    signal: res.signal || res.abortSignal || null,
    duration_ms: res.durationMs,
    post_hash: postHash,
    fingerprint: analysis.fingerprint,
    failure_kind: failureKind,
    class_result: classResult,
    raw_bytes: shaped.rawBytes,
    shown_bytes: shaped.shownBytes,
    first_fail_line: exit !== 0 ? redactText(analysis.firstFailLine) : null,
    loop_skipped: loopSkipped,
    loop_checked: loop ? !loop.skipped : false,
    key: prep.key,
    class: prep.cls,
    session: prep.session,
    log: logRel,
  };
  if (!startRec) {
    // Spawn failed before onSpawn: still write a start record so the pair is complete.
    startRec = startRecord(prep, id, {});
    store.append([startRec]);
  }
  store.append([endRec, ...extraRecs], summaryTweak(prep, learned && learned.becameConfirmed ? 1 : 0));
  clearActive(store, id);
  if (learned && learned.becameConfirmed) regenerateBriefing(prep.root);
  evictLogs(store, prep.config.values.log_budget_mb);

  const hints = [...fixHits].map((i) => fixes[i].hint);
  if (res.reason === 'timeout') notes.push(`killed the process tree after the ${formatDuration(o.timeoutMs)} total timeout`);
  if (res.reason === 'idle') notes.push(`killed the process tree after ${formatDuration(o.idleMs)} without output`);
  const footerNeeded = shaped.cut || exit !== 0 || timedOut || notes.length > 0 || hints.length > 0;
  const footer = footerNeeded
    ? `kerb: exit ${exit} · ${formatDuration(res.durationMs)} · ${formatBytes(shaped.rawBytes)} → ${formatBytes(shaped.shownBytes)} · log ${logRel}`
    : null;
  return { id, exit, classResult, shaped, analysis, notes, hints, footer, endRec, startRec, res, logRel };
}

/** Print shaped output (stdout) and footer, hints and notes (stderr). */
export function printRun(ctx, r, { showOutput = true } = {}) {
  if (ctx.json) {
    ctx.emitJson({
      refused: false, run: r.id, exit: r.exit, class_result: r.classResult, duration_ms: r.res.durationMs,
      raw_bytes: r.shaped.rawBytes, shown_bytes: r.shaped.shownBytes, output: r.shaped.text, footer: r.footer,
      hints: r.hints, notes: r.notes, log: r.logRel,
    });
    return;
  }
  if (showOutput && r.shaped.text) ctx.out(r.shaped.text);
  if (r.footer) ctx.err(`${paint(ctx.color.err, 'dim', r.footer)}\n`);
  for (const h of r.hints) ctx.err(`      hint: ${h}\n`);
  for (const n of r.notes) ctx.err(formatNote(n, ctx.color.err));
}

/** Evict logs oldest-first when .kerb/logs exceeds the log budget. Records are kept. */
export function evictLogs(store, budgetMb = 200) {
  const dir = path.join(store.dir, 'logs');
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const files = [];
  let total = 0;
  for (const n of names) {
    try {
      const st = fs.statSync(path.join(dir, n));
      files.push({ n, size: st.size, t: st.mtimeMs });
      total += st.size;
    } catch { /* gone */ }
  }
  const limit = (budgetMb || 200) * 1024 * 1024;
  if (total <= limit) return;
  files.sort((a, b) => a.t - b.t);
  for (const f of files) {
    if (total <= limit) break;
    try { fs.unlinkSync(path.join(dir, f.n)); total -= f.size; } catch { /* */ }
  }
}
