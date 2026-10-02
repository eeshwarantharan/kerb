// kerb export --format ker [--since 7d] [--no-text] [--out <file>]: the records as KER NDJSON,
// redacted, for memory tools, dashboards and research (KERB-V2 11.4). --no-text keeps only ids,
// counts, codes and hashes.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, parseDuration } from '../util/core.js';
import { openQuery, exportRecords } from '../platform/query.js';
import { parseOpts } from './args.js';

export default async function exportCmd(ctx, args) {
  const { opts, positionals } = parseOpts(args, { format: 'string', since: 'string', 'no-text': 'bool', out: 'string' });
  if (positionals.length) throw new UsageError('usage: kerb export --format ker [--since 7d] [--no-text] [--out <file>]');
  if ((opts.format || 'ker') !== 'ker') throw new UsageError(`unknown format ${opts.format}: the one format is ker`);
  const since = opts.since ? parseDuration(opts.since) : 0;
  if (opts.since && !since) throw new UsageError(`--since takes a duration like 7d (got ${opts.since})`);
  const q = openQuery({ cwd: ctx.cwd, env: ctx.env });
  const records = exportRecords(q.records(), { since, noText: !!opts['no-text'] });
  const ndjson = records.map((r) => `${JSON.stringify(r)}\n`).join('');
  if (opts.out) {
    const file = path.resolve(ctx.cwd, opts.out);
    fs.writeFileSync(file, ndjson);
    if (ctx.json) ctx.emitJson({ format: 'ker', count: records.length, out: file });
    else ctx.out(`kerb export · ${records.length} record${records.length === 1 ? '' : 's'} → ${path.relative(ctx.cwd, file) || file}\n`);
    return 0;
  }
  if (ctx.json) { ctx.emitJson({ format: 'ker', count: records.length, records }); return 0; }
  ctx.out(ndjson);
  return 0;
}
