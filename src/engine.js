// Shared orchestration for run, check, wait-for and the hook handlers:
// parse → human-only check → Boundary Map → Loopbreaker. The supervised runner lives in
// run/runner.js and is loaded only when a command runs.
import fs from 'node:fs';
import { newId, now, parseDuration } from './util/core.js';
import { findRoot, relPath } from './util/repo.js';
import { Store, buildRuns } from './store/jsonl.js';
import { loadSummary } from './store/summary.js';
import { loadConfig } from './config.js';
import { loadPolicy } from './bound/load.js';
import { humanOnlyRefusal } from './bound/human.js';
import { boundaryCheck } from './bound/precheck.js';
import { parseCommand } from './parse/tokenize.js';
import { classifyCommand, compileCheckCommands } from './parse/classify-cmd.js';
import { redactText } from './run/redact.js';
import { reapOrphans } from './run/orphans.js';
import { formatRefusal, refusalJson } from './ui/format.js';

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
 *   tier?: string, session?: string | null, reap?: boolean }} o
 */
export function prepare(ctx, o) {
  const nowTs = now();
  const { root, git } = findRoot(ctx.cwd);
  const store = new Store(root);
  const config = loadConfig();
  const policy = loadPolicy(root, config, nowTs);
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
    evidence: refusal.evidence,
    next: refusal.next,
    boundary: refusal.boundary ? `${refusal.boundary.kind}:${refusal.boundary.pattern}` : null,
    agent: prep.agent,
    tier: prep.tier,
    session: ensureSession(prep),
  };
  prep.store.ensure().append([rec], summaryTweak(prep));
  return rec;
}

function ensureSession(prep) {
  if (!prep.session) prep.session = resolveSession(prep.store);
  return prep.session;
}

export function wallsKnown(policy) {
  return (policy.boundaries || []).length;
}

/** Summary fields derived from the policy, refreshed with every record. */
export function summaryTweak(prep, extraWalls = 0) {
  return (s) => {
    s.walls_known = wallsKnown(prep.policy) + extraWalls;
    s.org_cache_expired = !!(prep.policy.org && prep.policy.org.stale);
  };
}

/** Fetch the org bundle when a managed config sets one and a refresh is due (or forced). */
export async function refreshOrgIfDue(force = false) {
  const { managed } = loadConfig();
  if (!managed || !managed.org || !managed.org.bundle_url) return null;
  const { refreshOrg } = await import('./bound/org.js');
  return refreshOrg(managed, { force });
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


export function startRecord(prep, id, extra = {}) {
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

