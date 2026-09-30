// kerb export-denials [--since 7d]: learned boundaries as JSONL for team review. No command text, no output.
import { now, parseDuration, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';
import { exportDenials } from '../bound/review.js';

export default async function exportDenialsCmd(ctx, args) {
  const { opts } = parseOpts(args, { since: 'string' });
  let ms;
  try { ms = parseDuration(opts.since || '7d'); } catch { throw new UsageError('--since takes a duration like 7d'); }
  const t = now();
  const entries = exportDenials(t - ms, t);
  if (ctx.json) ctx.emitJson({ entries });
  else for (const e of entries) ctx.out(`${JSON.stringify(e)}\n`);
  return 0;
}
