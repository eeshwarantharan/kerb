// kerb hook <agent> <event>: hook handler entry point (4.10). Always exits 0. Fails open:
// any internal error allows the call, is logged to ~/.kerb/errors.log and counted.
import path from 'node:path';
import { UsageError } from '../util/core.js';
import { logError } from '../util/fsx.js';
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { loadSummary, saveCount } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderRecap } from '../ui/recap.js';

export const HOOK_DEADLINE_MS = 1000;
const START_DEADLINE_MS = 3000;

const ADAPTERS = {
  claude: () => import('../adapters/claude.js'),
  copilot: () => import('../adapters/copilot.js'),
  cursor: () => import('../adapters/cursor.js'),
  codex: () => import('../adapters/codex.js'),
  gemini: () => import('../adapters/gemini.js'),
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
  const deadline = event === 'start' ? START_DEADLINE_MS : HOOK_DEADLINE_MS;
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
    default: throw new UsageError(`unknown hook event: ${event}`);
  }
}

/** SessionStart: refresh the org bundle, regenerate the briefing, tell the agent the boundaries. */
async function sessionStart(ctx, adapter, payload) {
  const { refreshOrgIfDue } = await import('../engine.js');
  await refreshOrgIfDue(true);
  const { regenerateBriefing, briefingLines } = await import('../init/instructions.js');
  const { root } = findRoot(ctx.cwd);
  regenerateBriefing(root);
  const lines = briefingLines(root);
  if (adapter.startOutput) return adapter.startOutput(lines, payload);
  return null;
}

/** Stop: the recap, only when this session has saves not yet shown. */
function sessionStop(ctx, adapter, payload) {
  const { values } = loadConfig();
  if (values.recap === 'off') return null;
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  const summary = loadSummary(path.join(root, '.kerb'));
  const id = payload.session_id || payload.sessionId || summary.current_session;
  const session = id && summary.sessions[id];
  if (!session) return null;
  const saves = saveCount(session.counters);
  const shown = (summary.recap_shown || {})[id] || 0;
  if (!saves || saves <= shown) return null;
  const text = renderRecap(session);
  if (!text) return null;
  store.updateSummary((s) => { s.recap_shown = { ...(s.recap_shown || {}), [id]: saves }; });
  return adapter.stopOutput ? adapter.stopOutput(text, payload) : { systemMessage: text };
}
