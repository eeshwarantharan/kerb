// kerb hook <agent> <event>: hook handler entry point (4.10). Always exits 0. Fails open:
// any internal error allows the call, is logged to ~/.kerb/errors.log and counted.
import path from 'node:path';
import { UsageError, now } from '../util/core.js';
import { logError } from '../util/fsx.js';
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { loadSummary, saveCount } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderRecap } from '../ui/recap.js';

export const HOOK_DEADLINE_MS = 1000;
const STOP_MAX_LINES = 8;
const START_DEADLINE_MS = 3000;

const ADAPTERS = {
  claude: () => import('../adapters/claude.js'),
  copilot: () => import('../adapters/copilot.js'),
  cursor: () => import('../adapters/cursor.js'),
  codex: () => import('../adapters/codex.js'),
  gemini: () => import('../adapters/gemini.js'),
  opencode: () => import('../adapters/opencode.js'),
};

let delayForTests = 0;
/** Tests only (in-process): make handlers slow, to exercise the deadline. */
export function setHookDelayForTests(ms) { delayForTests = ms; }

async function readStdin(ctx) {
  if (typeof ctx.stdin === 'string') return ctx.stdin;
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** Never emit an allow/approve decision, whatever a handler returned (deny-only). */
export function denyOnly(out) {
  if (!out || typeof out !== 'object') return null;
  const h = out.hookSpecificOutput;
  if (h && 'permissionDecision' in h && h.permissionDecision !== 'deny') {
    const { permissionDecision, permissionDecisionReason, updatedInput, ...rest } = h;
    void permissionDecision; void permissionDecisionReason; void updatedInput;
    out = { ...out, hookSpecificOutput: rest };
  }
  for (const k of ['decision', 'permission', 'permissionDecision']) {
    if (k in out && !['deny', 'block'].includes(out[k])) {
      const { [k]: _drop, ...rest } = out;
      void _drop;
      out = rest;
    }
  }
  if ('continue' in out && out.continue !== true) {
    const { continue: _c, ...rest } = out;
    void _c;
    out = rest;
  }
  return out;
}

function countError(cwd) {
  try {
    const { root } = findRoot(cwd);
    const store = new Store(root);
    store.updateSummary((s) => { s.errors = (s.errors || 0) + 1; });
  } catch { /* nothing more to do */ }
}

export default async function hook(ctx, args) {
  const [agent, event] = args;
  if (!agent || !event) throw new UsageError('usage: kerb hook <agent> <event>');
  if (!Object.hasOwn(ADAPTERS, agent)) throw new UsageError(`unknown agent: ${agent}`);
  let payload = {};
  let cwd = ctx.cwd;
  const deadline = ['start', 'end', 'stop', 'compact', 'turn'].includes(event) ? START_DEADLINE_MS : HOOK_DEADLINE_MS;
  const work = (async () => {
    const text = await readStdin(ctx);
    payload = text.trim() ? JSON.parse(text) : {};
    if (payload && typeof payload.cwd === 'string') cwd = payload.cwd;
    if (delayForTests) await new Promise((r) => setTimeout(r, delayForTests));
    return handle(ctx, agent, event, payload);
  })();
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), deadline); });
  let out = null;
  try {
    const r = await Promise.race([work.then((v) => ({ value: v })), timeout]);
    if (r.timedOut) {
      logError(`hook ${agent} ${event}`, new Error(`deadline of ${deadline}ms exceeded; allowed`));
      countError(cwd);
    } else out = r.value;
  } catch (e) {
    logError(`hook ${agent} ${event}`, e);
    countError(cwd);
    out = null;
  } finally {
    clearTimeout(timer);
  }
  const safe = denyOnly(out);
  if (safe && Object.keys(safe).length) ctx.out(`${JSON.stringify(safe)}\n`);
  return 0;
}

async function handle(ctx, agent, event, payload) {
  const adapter = await ADAPTERS[agent]();
  const hctx = { ...ctx, cwd: typeof payload.cwd === 'string' ? payload.cwd : ctx.cwd };
  switch (event) {
    case 'pre': return adapter.pre(hctx, payload);
    case 'post': return adapter.post(hctx, payload, { failure: false });
    case 'post-failure': return adapter.post(hctx, payload, { failure: true });
    case 'start': return sessionStart(hctx, adapter, payload);
    case 'stop': return sessionStop(hctx, adapter, payload);
    case 'compact': return compacted(hctx, adapter, payload);
    case 'turn': return turnStart(hctx, adapter, payload);
    case 'end': return sessionEnd(hctx, payload);
    default: throw new UsageError(`unknown hook event: ${event}`);
  }
}

/** Session sources that mean the conversation already ran and lost detail (KERB-V2 9). */
export const AFTER_SOURCES = new Set(['compact', 'resume', 'fork']);

function sessionId(payload) {
  return payload.session_id || payload.sessionId || payload.conversation_id || payload.sessionID || null;
}

async function startContext(ctx, payload, after) {
  const { prepare } = await import('../engine.js');
  const { regenerateBriefing, briefingLines } = await import('../init/instructions.js');
  const { sessionStartText } = await import('../insight/deliver.js');
  const prep = prepare(ctx, { command: 'true', reap: false });
  if (!after) regenerateBriefing(prep.root);
  return sessionStartText({
    root: prep.root, git: prep.git, store: prep.store, policy: prep.policy, env: ctx.env, nowTs: now(), after,
    session: sessionId(payload), briefing: after ? [] : briefingLines(prep.root), insights: prep.config.values.insights !== 'off',
  });
}

/**
 * SessionStart: refresh the org bundle; a fresh session gets the briefing and the ledger, one
 * after compaction or resume gets the ledger and verification status (KERB-V2 9).
 */
async function sessionStart(ctx, adapter, payload) {
  const { refreshOrgIfDue } = await import('../engine.js');
  await refreshOrgIfDue(true);
  const after = AFTER_SOURCES.has(String(payload.source || ''));
  const text = await startContext(ctx, payload, after);
  if (!text || !adapter.startOutput) return null;
  return adapter.startOutput(text, payload);
}

/**
 * Compaction (Gemini PreCompress, OpenCode session.compacting). Agents with a context channel
 * here get the ledger now; the others get it at the start of the next turn (`turn`).
 */
async function compacted(ctx, adapter, payload) {
  if (adapter.compactOutput) {
    const text = await startContext(ctx, payload, true);
    return text ? adapter.compactOutput(text, payload) : null;
  }
  const { root } = findRoot(ctx.cwd);
  const { writePending } = await import('../adapters/pending.js');
  writePending(path.join(root, '.kerb'), `compacted-${sessionId(payload) || 'session'}`, { wall_ts: Date.now() });
  return null;
}

/** The start of a turn (Gemini BeforeAgent): the ledger once, after a compaction. */
async function turnStart(ctx, adapter, payload) {
  const { root } = findRoot(ctx.cwd);
  const { takePending } = await import('../adapters/pending.js');
  if (!takePending(path.join(root, '.kerb'), `compacted-${sessionId(payload) || 'session'}`)) return null;
  const text = await startContext(ctx, payload, true);
  return text && adapter.turnOutput ? adapter.turnOutput(text, payload) : null;
}

/** Session end: send the telemetry batch (only when configured). No output. */
async function sessionEnd(ctx, payload) {
  const { sendSessionTelemetry } = await import('../telemetry/otlp.js');
  const { root } = findRoot(ctx.cwd);
  await sendSessionTelemetry(root, payload.session_id || payload.sessionId || payload.conversation_id || null);
  return null;
}

/**
 * Stop: the recap, only when this session has saves not yet shown; the verification warning
 * (or, with policy stop_gate "block", one block per state); and, once, the prompt to review
 * shadow mode (KERB-V2 7.2, 9, 10.2).
 */
async function sessionStop(ctx, adapter, payload) {
  const config = loadConfig();
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  const summary = loadSummary(path.join(root, '.kerb'));
  let recap = [];
  const parts = [];
  const id = sessionId(payload) || summary.current_session;
  const session = id && summary.sessions[id];
  if (config.values.recap !== 'off' && session) {
    const saves = saveCount(session.counters);
    const shown = (summary.recap_shown || {})[id] || 0;
    const text = saves > shown ? renderRecap(session) : '';
    if (text) {
      recap = text.split('\n');
      store.updateSummary((s) => { s.recap_shown = { ...(s.recap_shown || {}), [id]: saves }; });
    }
  }
  let block = null;
  if (config.values.insights !== 'off') {
    try {
      const { prepare } = await import('../engine.js');
      const { stopVerification } = await import('../insight/deliver.js');
      const prep = prepare(ctx, { command: 'true', reap: false });
      const v = stopVerification({ root, git: prep.git, store, policy: prep.policy, env: ctx.env, session: id, loadSummary: () => loadSummary(path.join(root, '.kerb')) });
      parts.push(...v.lines);
      if (v.block && adapter.stopBlock) block = v.block;
    } catch (e) { logError('stop verification', e); }
  }
  // Once: cause isolation could have run, if a person turns it on (KERB-V2 8.1).
  if (summary.cause_offer && !summary.cause_offered) {
    const t = String(summary.cause_offer.test || '');
    parts.push(`kerb: note · Kerb could have isolated which change broke "${t.slice(t.indexOf('::') + 2)}"; to let it, run kerb config set cause on (it runs your tests in the background)`);
    store.updateSummary((s) => { s.cause_offered = true; });
  }
  const { shadowPrompt, markPrompted } = await import('../mode.js');
  const prompt = shadowPrompt(root, config, summary, now());
  if (prompt) parts.push(prompt);
  // At most 8 lines (KERB-V2 9): verification and the shadow prompt stay; recap rows give way.
  const rest = parts.join('\n').split('\n').filter(Boolean);
  if (recap.length) recap = recap.slice(0, Math.max(2, STOP_MAX_LINES - rest.length));
  const lines = [...recap, ...rest].slice(0, STOP_MAX_LINES);
  if (block) return adapter.stopBlock(block, payload, lines.join('\n'));
  if (!lines.length) return null;
  const text = lines.join('\n');
  const out = adapter.stopOutput ? adapter.stopOutput(text, payload) : { systemMessage: text };
  // Only count the prompt as shown when this agent can show it (Cursor and OpenCode can't).
  if (prompt && out) markPrompted(root, now());
  return out;
}
