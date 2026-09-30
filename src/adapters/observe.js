// Agent-neutral hook logic (4.10.1, 4.10.2), pre side: refuse, or record a pending run.
// Deny-only: a handler returns a refusal or nothing, never an allow. The post side lives in
// observe-post.js and is loaded only by post hooks, so pre hooks stay fast.
import { newId, now, sha256 } from '../util/core.js';
import { prepare, preRefusal, recordRefusal } from '../engine.js';
import { redactText } from '../run/redact.js';
import { writePending, peekPending, prunePending, kerbInnerCommands } from './pending.js';
import { kerbArgv } from '../bound/human.js';

export const HOOK_HASH_BUDGET_MS = 300;
const DUPLICATE_WINDOW_MS = 3000;

/**
 * Call id for agents whose payloads carry none: session + cwd + command. The same call seen
 * through two hook files (Copilot CLI also reads .claude/settings) maps to one id.
 */
export function callId(toolUseId, session, cwd, command) {
  if (toolUseId) return String(toolUseId);
  return `h${sha256(`${session || ''}\0${cwd}\0${command}`).slice(0, 24)}`;
}

export function hookCounter(store, agent, field) {
  store.updateSummary((s) => {
    s.hooks[agent] = s.hooks[agent] || { pre: 0, post: 0, full: 0, background: 0 };
    s.hooks[agent][field] = (s.hooks[agent][field] || 0) + 1;
  });
}

/**
 * @param {any} ctx CLI context (cwd is overridden by the payload's cwd)
 * @param {{ agent: string, command: string, cwd: string, background?: boolean, toolUseId: string,
 *   session?: string | null, agentTimeoutMs?: number | null, hashBudgetMs?: number }} o
 * @returns {{ refusal: any | null, notes: string[] }}
 */
export async function observePre(ctx, o) {
  const hctx = { ...ctx, cwd: o.cwd };
  const prep = prepare(hctx, { command: o.command, background: !!o.background, agent: o.agent, tier: 'enforced', session: o.session || null });
  prep.store.ensure();
  prunePending(prep.store.dir);
  // The same call seen again within a few seconds (a second hook file): same answer, no new records.
  const seen = peekPending(prep.store.dir, o.toolUseId);
  if (seen && seen.command === o.command && Date.now() - seen.wall_ts < DUPLICATE_WINDOW_MS) {
    return { refusal: seen.refusal || null, notes: seen.notes || [] };
  }
  hookCounter(prep.store, o.agent, 'pre');
  const deny = (refusal, matched) => {
    recordRefusal(prep, refusal, matched);
    const r = { ...refusal, key: prep.key };
    delete r.boundary;
    writePending(prep.store.dir, o.toolUseId, { command: o.command, wall_ts: Date.now(), refusal: r, denied: true });
    return { refusal: r, notes: [] };
  };
  const pre = preRefusal(prep);
  if (pre.refusal) return deny(pre.refusal, null);
  const isKerb = prep.parsed.segments.some((s) => kerbArgv(s));
  const pending = {
    id: newId(),
    ts: now(),
    wall_ts: Date.now(),
    key: prep.key,
    class: prep.cls,
    cmd: redactText(o.command),
    command: o.command,
    cwd: o.cwd,
    cwd_rel: prep.cwdRel,
    agent: o.agent,
    session: prep.session || o.session || null,
    agent_timeout_ms: o.agentTimeoutMs || null,
    kerb: isKerb,
    kerb_inner: isKerb ? kerbInnerCommands(prep.parsed) : undefined,
    scope: null,
    pre_hash: null,
    env_stamp: null,
    loop_skipped: null,
    notes: pre.notes,
  };
  // Kerb invocations record themselves; background calls get the pre-check only.
  if (!isKerb && prep.cls === 'check') {
    const { loopGate } = await import('../loop/gate.js');
    const gate = loopGate(prep, { hashBudgetMs: o.hashBudgetMs || HOOK_HASH_BUDGET_MS });
    if (gate.refusal) return deny(gate.refusal, gate.matched);
    Object.assign(pending, { scope: gate.loop.scope, pre_hash: gate.loop.preHash, env_stamp: gate.loop.envStamp, loop_skipped: gate.loop.skipped });
  }
  writePending(prep.store.dir, o.toolUseId, pending);
  return { refusal: null, notes: pre.notes };
}

