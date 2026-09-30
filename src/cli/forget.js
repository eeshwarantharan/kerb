// kerb forget <pattern> (human-only): remove a learned boundary.
import { UsageError } from '../util/core.js';
import { parseOpts } from './args.js';
import { requireHuman } from '../bound/human.js';
import { forgetLearned } from '../bound/learn.js';

export default async function forget(ctx, args) {
  const { positionals } = parseOpts(args, {});
  if (positionals.length !== 1) throw new UsageError('usage: kerb forget <pattern>');
  requireHuman('kerb forget');
  const removed = forgetLearned(positionals[0]);
  if (ctx.json) ctx.emitJson({ removed: removed.map((e) => e.pattern) });
  else if (removed.length) ctx.out(`kerb: forget · removed ${removed.map((e) => e.pattern).join(', ')}\n`);
  else ctx.out(`kerb: forget · no learned boundary matches ${positionals[0]}\n`);
  return 0;
}
