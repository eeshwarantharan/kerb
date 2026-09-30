// kerb run [opts] -- <command>: pre-check, run under the supervisor, shape output, record.
import { EXIT, UsageError } from '../util/core.js';
import { parseOpts, commandFromRest } from './args.js';
import { requireHuman } from '../bound/human.js';
import { prepare, preRefusal, recordRefusal, emitRefusal, limits, refreshOrgIfDue } from '../engine.js';
import { loopGate } from '../loop/gate.js';
import { hookContextFor } from '../adapters/pending.js';
import { formatNote } from '../ui/format.js';

export const RUN_SPEC = {
  timeout: 'string', idle: 'string', budget: 'string', key: 'string', class: 'string', force: 'bool',
};

export default async function run(ctx, args) {
  const { opts, rest } = parseOpts(args, RUN_SPEC);
  const command = commandFromRest(rest, 'run');
  if (opts.class && !['check', 'query', 'other'].includes(opts.class)) throw new UsageError('--class must be check, query or other');
  if (opts.budget && !(Number(opts.budget) >= 200)) throw new UsageError('--budget must be a number of bytes (at least 200)');
  if (opts.force) requireHuman('kerb run --force');

  const hook = hookContextFor(ctx.cwd, command);
  await refreshOrgIfDue();
  const prep = prepare(ctx, {
    command,
    key: opts.key,
    cls: opts.class,
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
  const { runBackground, runSupervised, printRun } = await import('../run/runner.js');
  if (prep.cls === 'background') {
    for (const n of pre.notes) ctx.err(formatNote(n, ctx.color.err));
    const code = await runBackground(prep);
    if (ctx.json) ctx.emitJson({ refused: false, background: true, exit: code });
    return code;
  }

  const gate = prep.cls === 'check' ? loopGate(prep, { force: !!opts.force, hashBudgetMs: prep.config.values.hash_budget_ms || 2000 }) : null;
  if (gate && gate.refusal) {
    recordRefusal(prep, gate.refusal, gate.matched);
    emitRefusal(ctx, gate.refusal, prep.key);
    return EXIT.LOOP;
  }
  const lim = limits(prep, { ...opts, agentTimeoutMs: hook ? hook.agentTimeoutMs : null });
  const r = await runSupervised(prep, { ...lim, loop: gate ? gate.loop : null, notes: pre.notes });
  printRun(ctx, r);
  return r.exit;
}
