// kerb check [--json] -- <command>: pre-check only. Never runs anything. Exit 0 if it would run.
import { UsageError } from '../util/core.js';
import { parseOpts, commandFromRest } from './args.js';
import { prepare, preRefusal, emitRefusal } from '../engine.js';
import { loopGate } from '../loop/gate.js';
import { formatNote } from '../ui/format.js';

export default async function check(ctx, args) {
  const { opts, rest } = parseOpts(args, { key: 'string', class: 'string' });
  const command = commandFromRest(rest, 'check');
  if (opts.class && !['check', 'query', 'other'].includes(opts.class)) throw new UsageError('--class must be check, query or other');
  const prep = prepare(ctx, { command, key: opts.key, cls: opts.class });
  const pre = preRefusal(prep);
  let refusal = pre.refusal;
  if (!refusal && prep.cls === 'check') {
    const gate = loopGate(prep, { force: false, hashBudgetMs: prep.config.values.hash_budget_ms || 2000, dryRun: true });
    refusal = gate.refusal;
  }
  if (refusal) {
    emitRefusal(ctx, refusal, prep.key);
    return refusal.exit;
  }
  if (ctx.json) ctx.emitJson({ refused: false, class: prep.cls, key: prep.key, notes: pre.notes });
  else for (const n of pre.notes) ctx.err(formatNote(n, ctx.color.err));
  return 0;
}
