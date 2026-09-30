// kerb wait-for [--until success|exit:<n>|output:<regex>] [--interval 5s] [--max 3m] [--backoff] -- <command>
import { parseOpts, commandFromRest } from './args.js';
import { prepare, preRefusal, recordRefusal, emitRefusal, limits } from '../engine.js';
import { waitFor, waitOptions } from '../run/wait.js';
import { hookContextFor } from '../adapters/pending.js';
import { checkSegment } from '../parse/classify-cmd.js';
import { hashWorkspace, scopeAndStamp, writeSnapshot } from '../loop/workspace.js';
import { formatNote, paint } from '../ui/format.js';
import { formatDuration } from '../util/core.js';

export default async function waitForCmd(ctx, args) {
  const { opts, rest } = parseOpts(args, {
    until: 'string', interval: 'string', max: 'string', backoff: 'bool', idle: 'string', budget: 'string', key: 'string',
  });
  const command = commandFromRest(rest, 'wait-for');
  const hook = hookContextFor(ctx.cwd, command);
  const w = waitOptions(opts, hook ? hook.agentTimeoutMs : null);
  const prep = prepare(ctx, {
    command,
    key: opts.key,
    agent: hook ? hook.agent : undefined,
    tier: hook ? 'enforced' : undefined,
    session: hook ? hook.session : undefined,
  });
  const pre = preRefusal(prep);
  if (pre.refusal) {
    recordRefusal(prep, pre.refusal);
    emitRefusal(ctx, pre.refusal, prep.key);
    return pre.refusal.exit;
  }
  if (!prep.session) prep.session = (await import('../engine.js')).resolveSession(prep.store);
  // Loop state is recorded for check commands so a successful wait clears the key.
  let loop = null;
  if (prep.cls === 'check') {
    const seg = checkSegment(prep.parsed, prep.checkCommands);
    const { scope, envStamp } = scopeAndStamp(prep, seg ? seg.cwd : ctx.cwd);
    const hctx = { root: prep.root, git: prep.git, policy: prep.policy, env: ctx.env };
    const budget = prep.config.values.hash_budget_ms || 2000;
    const pre0 = hashWorkspace(hctx, scope, budget);
    loop = {
      preHash: pre0.hash, envStamp, skipped: pre0.skipped,
      postHash(id) { const p = hashWorkspace(hctx, scope, budget); if (p.snapshot) writeSnapshot(prep.store, id, p.snapshot); return { hash: p.hash }; },
    };
  }
  const lim = limits(prep, { idle: opts.idle, budget: opts.budget });
  const notes = [...pre.notes];
  if (w.capped) notes.push(`--max capped at ${formatDuration(w.maxMs)} (the agent's tool timeout minus 10 s)`);
  const r = await waitFor(prep, { ...w, idleMs: lim.idleMs, budget: lim.budget, loop });
  if (ctx.json) {
    ctx.emitJson({ refused: false, wait: true, result: r.rec.result, attempts: r.rec.attempts, duration_ms: r.rec.duration_ms, exit: r.exit, final_exit: r.rec.final_exit, output: r.output, summary: r.summary, log: r.logRel, notes });
    return r.exit;
  }
  if (r.output) ctx.out(r.output);
  ctx.err(`${paint(ctx.color.err, r.exit === 0 ? 'green' : 'dim', r.summary)}\n`);
  for (const n of notes) ctx.err(formatNote(n, ctx.color.err));
  return r.exit;
}
