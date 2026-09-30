// Shared orchestration for run, check, wait-for and the hook handlers:
// parse → human-only check → Boundary Map → Loopbreaker → supervise → shape → record.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, newId, now, parseDuration, formatBytes, formatDuration } from './util/core.js';
import { ensureDir } from './util/fsx.js';
import { findRoot, relPath } from './util/repo.js';
import { Store, buildRuns } from './store/jsonl.js';
import { loadSummary } from './store/summary.js';
import { loadConfig } from './config.js';
import { loadPolicy } from './bound/load.js';
import { humanOnlyRefusal } from './bound/human.js';
import { boundaryCheck } from './bound/precheck.js';
import { DenialScanner, isNetworkCapable, recordDenial } from './bound/learn.js';
import { parseCommand } from './parse/tokenize.js';
import { classifyCommand, compileCheckCommands } from './parse/classify-cmd.js';
import { commandHosts } from './parse/hosts.js';
import { Analyzer, compilePatterns } from './loop/fingerprint.js';
import { Shaper } from './run/shape.js';
import { redactText } from './run/redact.js';
import { supervise, markActive, clearActive, activeRuns, reapOrphans, passthrough, SIGNUMS } from './run/supervisor.js';
import { formatNote, formatRefusal, paint, refusalJson } from './ui/format.js';

const SESSION_GAP_MS = 30 * 60_000;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_IDLE_MS = 10 * 60_000;

/** Collapse runs of whitespace; keep leading VAR=value assignments (they change behaviour). */
export function makeKey(root, cwd, command) {
  return `${relPath(root, cwd)}::${command.trim().replace(/\s+/g, ' ')}`;
}

/** Which agent is running us, from well-known environment markers. */
export function detectAgent(env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  if (env.GEMINI_CLI) return 'gemini';
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor';
  if (env.CODEX_SANDBOX || env.CODEX_HOME) return 'codex';
  return null;
}

/** Session id: the hook's, else the current one if active in the last 30 minutes, else new. */
export function resolveSession(store, explicit) {
  if (explicit) return String(explicit);
  const s = loadSummary(store.dir);
  if (s.current_session && now() - (s.updated || 0) < SESSION_GAP_MS) return s.current_session;
  return `s${newId()}`;
}

/**
 * Build the per-command context.
 * @param {ReturnType<import('./cli/context.js').createContext>} ctx
 * @param {{ command: string, key?: string, cls?: string, background?: boolean, agent?: string | null,
 *   tier?: string, session?: string | null, refreshOrg?: boolean, reap?: boolean }} o
 */
export function prepare(ctx, o) {
  const nowTs = now();
  const { root, git } = findRoot(ctx.cwd);
  const store = new Store(root);
  const config = loadConfig();
  const policy = loadPolicy(root, config, nowTs, { refreshOrg: o.refreshOrg });
  const parsed = parseCommand(o.command, { cwd: ctx.cwd });
  const checkCommands = compileCheckCommands(policy.check_commands);
  const cls = o.cls || classifyCommand(parsed, { checkCommands, background: !!o.background });
  if (o.reap !== false && fs.existsSync(store.dir)) reapOrphans(store, (info) => orphanEnd(info));
  const agent = o.agent !== undefined ? o.agent : detectAgent(ctx.env);
  return {
    ctx,
    nowTs,
    root,
    git,
    store,
    config,
    policy,
    parsed,
    checkCommands,
    cls,
    command: o.command,
    key: o.key || makeKey(root, ctx.cwd, o.command),
    cwdRel: relPath(root, ctx.cwd),
    agent,
    tier: o.tier || (agent ? 'best effort' : null),
    session: o.session === undefined ? null : o.session,
  };
}

function orphanEnd(info) {
  return {
    type: 'end', id: info.id, ts: now(), exit: null, signal: 'SIGKILL', duration_ms: now() - (info.ts || now()),
    post_hash: null, fingerprint: null, failure_kind: null, class_result: 'aborted', raw_bytes: 0, shown_bytes: 0,
    first_fail_line: null, loop_skipped: null, key: info.key, class: info.class, session: info.session,
  };
}

/**
 * Human-only check and Boundary Map pre-check.
 * @returns {{ refusal: any | null, notes: string[], hosts: string[] }}
 */
export function preRefusal(prep) {
  const human = humanOnlyRefusal(prep.parsed);
  if (human) return { refusal: human, notes: [], hosts: [] };
  return boundaryCheck(prep.parsed, prep.policy, { env: prep.ctx.env });
}

/** Append a refusal record. */
export function recordRefusal(prep, refusal, matched = null) {
  const rec = {
    type: 'refusal',
    id: newId(),
    ts: now(),
    key: prep.key,
    reason: refusal.reason,
    matched_run: matched ? matched.id : null,
    avoided_duration_ms: matched ? matched.duration_ms || 0 : 0,
    avoided_output_bytes: matched ? matched.shown_bytes || 0 : 0,
    class: prep.cls,
    cmd: redactText(prep.command),
    summary: refusal.summary,
    agent: prep.agent,
    tier: prep.tier,
    session: ensureSession(prep),
  };
  prep.store.ensure().append([rec], (s) => { s.walls_known = wallsKnown(prep.policy); });
  return rec;
}

function ensureSession(prep) {
  if (!prep.session) prep.session = resolveSession(prep.store);
  return prep.session;
}

export function wallsKnown(policy) {
  return (policy.boundaries || []).length;
}

/** Print a refusal to the right stream in the right form. */
export function emitRefusal(ctx, refusal, key) {
  const r = { ...refusal, key: refusal.key ?? key };
  if (ctx.json) ctx.emitJson(refusalJson(r));
  else ctx.err(formatRefusal(r, ctx.color.err));
}

/** Read this repo's runs (joined), or [] if there is no state yet. */
export function loadRuns(store) {
  if (!fs.existsSync(store.file)) return { recs: [], runs: [] };
  const recs = store.read();
  return { recs, runs: buildRuns(recs) };
}

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

function startRecord(prep, id, extra = {}) {
  return {
    type: 'start',
    id,
    ts: now(),
    key: prep.key,
    class: prep.cls,
    cmd: redactText(prep.command),
    cwd: prep.cwdRel,
    scope: extra.scope ?? null,
    pre_hash: extra.pre_hash ?? null,
    env_stamp: extra.env_stamp ?? null,
    kerb_pid: process.pid,
    pgid: extra.pgid ?? null,
    agent: prep.agent,
    tier: prep.tier,
    session: ensureSession(prep),
  };
}

/**
 * Effective limits for a supervised run.
 * @param {any} prep
 * @param {{ timeout?: string, idle?: string, budget?: string, agentTimeoutMs?: number | null }} opts
 */
export function limits(prep, opts) {
  const cv = prep.config.values;
  let timeoutMs = opts.timeout ? parseDuration(opts.timeout) : null;
  if (timeoutMs == null) {
    timeoutMs = opts.agentTimeoutMs ? Math.max(1000, opts.agentTimeoutMs - 10_000) : parseDuration(cv.timeout || '30m');
  } else if (opts.agentTimeoutMs) {
    timeoutMs = Math.min(timeoutMs, Math.max(1000, opts.agentTimeoutMs - 10_000));
  }
  const idleMs = opts.idle ? parseDuration(opts.idle) : parseDuration(cv.idle || '10m');
  const budget = opts.budget ? Number(opts.budget) : Number(cv.budget) || 12_000;
  return { timeoutMs, idleMs, budget };
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
  store.append([endRec, ...extraRecs], (s) => { s.walls_known = wallsKnown(prep.policy) + (learned && learned.becameConfirmed ? 1 : 0); });
  clearActive(store, id);
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
