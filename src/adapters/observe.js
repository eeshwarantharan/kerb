// Agent-neutral hook logic (4.10.1, 4.10.2): the pre hook refuses or records a pending run;
// the post hook turns the agent's result into start/end records. Deny-only: a handler returns
// a refusal or nothing, never an allow.
import path from 'node:path';
import { newId, now } from '../util/core.js';
import { ensureDir } from '../util/fsx.js';
import { relPath } from '../util/repo.js';
import { prepare, preRefusal, recordRefusal, summaryTweak, resolveSession } from '../engine.js';
import { loopGate } from '../loop/gate.js';
import { hashWorkspace, scopeAndStamp, writeSnapshot } from '../loop/workspace.js';
import { checkSegment } from '../parse/classify-cmd.js';
import { commandHosts } from '../parse/hosts.js';
import { Shaper } from '../run/shape.js';
import { redactText } from '../run/redact.js';
import { Analyzer, compilePatterns } from '../loop/fingerprint.js';
import { DenialScanner, isNetworkCapable, recordDenial } from '../bound/learn.js';
import { writePending, takePending, prunePending, kerbInnerCommands } from './pending.js';
import { kerbArgv } from '../bound/human.js';
import { regenerateBriefing } from '../init/instructions.js';

export const HOOK_HASH_BUDGET_MS = 300;

function hookCounter(store, agent, field) {
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
export function observePre(ctx, o) {
  const hctx = { ...ctx, cwd: o.cwd };
  const prep = prepare(hctx, { command: o.command, background: !!o.background, agent: o.agent, tier: 'enforced', session: o.session || null });
  prep.store.ensure();
  prunePending(prep.store.dir);
  hookCounter(prep.store, o.agent, 'pre');
  const pre = preRefusal(prep);
  if (pre.refusal) {
    recordRefusal(prep, pre.refusal);
    return { refusal: { ...pre.refusal, key: prep.key }, notes: [] };
  }
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
  };
  // Kerb invocations record themselves; background calls get the pre-check only.
  if (!isKerb && prep.cls === 'check') {
    const gate = loopGate(prep, { hashBudgetMs: o.hashBudgetMs || HOOK_HASH_BUDGET_MS });
    if (gate.refusal) {
      recordRefusal(prep, gate.refusal, gate.matched);
      return { refusal: { ...gate.refusal, key: prep.key }, notes: [] };
    }
    Object.assign(pending, { scope: gate.loop.scope, pre_hash: gate.loop.preHash, env_stamp: gate.loop.envStamp, loop_skipped: gate.loop.skipped });
  }
  writePending(prep.store.dir, o.toolUseId, pending);
  return { refusal: null, notes: pre.notes };
}

/**
 * @param {any} ctx
 * @param {{ agent: string, toolUseId: string, cwd: string, command: string, exit: number | null,
 *   output: string, durationMs?: number | null, interrupted?: boolean, timedOut?: boolean,
 *   session?: string | null, hashBudgetMs?: number }} o
 * @returns {{ notes: string[], hints: string[] }}
 */
export function observePost(ctx, o) {
  const hctx = { ...ctx, cwd: o.cwd };
  const prep = prepare(hctx, { command: o.command, agent: o.agent, tier: 'enforced', session: o.session || null, reap: false });
  const { store } = prep;
  store.ensure();
  const pending = takePending(store.dir, o.toolUseId);
  hookCounter(store, o.agent, pending ? 'full' : 'post');
  if (pending && pending.kerb) return { notes: [], hints: [] };
  if (pending) prep.session = pending.session || prep.session;
  if (!prep.session) prep.session = resolveSession(store);
  const id = pending ? pending.id : newId();
  const cls = pending ? pending.class : prep.cls;
  const startTs = pending ? pending.ts : now() - (o.durationMs || 0);

  // Background launches: record that something was started (it makes a retry legitimate).
  if (cls === 'background') {
    store.append([
      startRecord(prep, id, startTs, pending, cls),
      endRecord(prep, id, cls, { exit: null, class_result: 'ok', duration_ms: 0, raw_bytes: 0, shown_bytes: 0 }),
    ], summaryTweak(prep));
    return { notes: [], hints: [] };
  }

  const logDir = ensureDir(path.join(store.dir, 'logs'));
  const logPath = path.join(logDir, `${id}.log`);
  const analyzer = new Analyzer({ transient: compilePatterns(prep.policy.transient_patterns), dependency: compilePatterns(prep.policy.dependency_patterns) });
  const denials = new DenialScanner();
  const fixes = (prep.policy.fixes || []).filter((f) => !f.key_contains || prep.key.includes(f.key_contains));
  const hints = new Set();
  const shaper = new Shaper({
    logPath,
    budget: 1 << 30,
    onLine: (line) => {
      analyzer.line(line);
      denials.line(line);
      for (const f of fixes) if (f.output_contains && line.includes(f.output_contains)) hints.add(f.hint);
    },
  });
  shaper.push(Buffer.from(o.output || '', 'utf8'));
  const shaped = shaper.end();
  const analysis = analyzer.result({ timedOut: !!o.timedOut });
  const notes = [];

  let classResult;
  if (o.interrupted) classResult = 'aborted';
  else if (o.timedOut) classResult = 'timeout';
  else if (o.exit === 0) classResult = 'ok';
  else classResult = 'failure';

  const extra = [];
  let learnedNew = false;
  if (o.exit !== 0 && !o.interrupted) {
    const hosts = commandHosts(prep.parsed, { env: hctx.env }).map((h) => h.host);
    const denial = denials.resolve(hosts, isNetworkCapable(prep.parsed, hosts));
    if (denial) {
      const learned = recordDenial({ host: denial.host, strength: denial.strength, key: prep.key, runId: id, nowTs: now() });
      learnedNew = learned.becameConfirmed;
      classResult = 'policy_denial';
      extra.push({ type: 'learn', id: newId(), ts: now(), host: denial.host, status: learned.entry.status, run: id, session: prep.session, new: learned.becameConfirmed });
      notes.push(learned.entry.status === 'confirmed'
        ? `recorded a policy block for ${denial.host}; it will be refused before running next time`
        : `${denial.host} may be blocked here (seen ${learned.entry.hits} time${learned.entry.hits === 1 ? '' : 's'})`);
    }
  }

  let postHash = null;
  let loopSkipped = pending ? pending.loop_skipped : null;
  if (cls === 'check' && pending && pending.pre_hash && !loopSkipped) {
    const seg = checkSegment(prep.parsed, prep.checkCommands);
    const { scope } = scopeAndStamp(prep, seg ? seg.cwd : o.cwd);
    const post = hashWorkspace({ root: prep.root, git: prep.git, policy: prep.policy, env: hctx.env }, scope, o.hashBudgetMs || HOOK_HASH_BUDGET_MS);
    postHash = post.hash;
    if (post.skipped) loopSkipped = post.skipped;
    if (post.snapshot) writeSnapshot(store, id, post.snapshot);
  }
  const failureKind = classResult === 'failure' || classResult === 'timeout' ? (o.timedOut ? 'transient' : analysis.kind) : null;
  store.append([
    startRecord(prep, id, startTs, pending, cls),
    endRecord(prep, id, cls, {
      exit: o.exit,
      duration_ms: o.durationMs ?? now() - startTs,
      post_hash: postHash,
      fingerprint: analysis.fingerprint,
      failure_kind: failureKind,
      class_result: classResult,
      raw_bytes: shaped.rawBytes,
      shown_bytes: shaped.rawBytes,
      first_fail_line: o.exit !== 0 ? redactText(analysis.firstFailLine) : null,
      loop_skipped: loopSkipped,
      loop_checked: cls === 'check' && !!pending && !loopSkipped,
      log: relPath(prep.root, logPath),
    }),
    ...extra,
  ], summaryTweak(prep, learnedNew ? 1 : 0));
  if (learnedNew) regenerateBriefing(prep.root);
  return { notes, hints: [...hints] };
}

function startRecord(prep, id, ts, pending, cls) {
  return {
    type: 'start', id, ts, key: prep.key, class: cls, cmd: redactText(prep.command), cwd: prep.cwdRel,
    scope: pending ? pending.scope : null, pre_hash: pending ? pending.pre_hash : null, env_stamp: pending ? pending.env_stamp : null,
    kerb_pid: null, pgid: null, agent: prep.agent, tier: 'enforced', session: prep.session, observed: true,
  };
}

function endRecord(prep, id, cls, f) {
  return {
    type: 'end', id, ts: now(), exit: f.exit, signal: null, duration_ms: f.duration_ms, post_hash: f.post_hash ?? null,
    fingerprint: f.fingerprint ?? null, failure_kind: f.failure_kind ?? null, class_result: f.class_result,
    raw_bytes: f.raw_bytes, shown_bytes: f.shown_bytes, first_fail_line: f.first_fail_line ?? null,
    loop_skipped: f.loop_skipped ?? null, loop_checked: !!f.loop_checked, key: prep.key, class: cls, session: prep.session, log: f.log ?? null,
  };
}
