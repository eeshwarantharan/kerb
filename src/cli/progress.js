// kerb progress [--key K] [--json]: the failing series per check key since its last success, with
// its signal: green, oscillating, stalled, diverging or converging (KERB-V2 7.3).
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { now, UsageError } from '../util/core.js';
import { progress, series } from '../insight/converge.js';
import { recentKeys, WINDOW_MS } from '../insight/ledger.js';
import { parseOpts } from './args.js';

export default async function progressCmd(ctx, args) {
  const { opts } = parseOpts(args, { key: 'string' });
  const { root } = findRoot(ctx.cwd);
  const recs = new Store(root).read();
  let keys = recentKeys(recs, now() - WINDOW_MS);
  if (opts.key) {
    keys = keys.filter((k) => k === opts.key || k.endsWith(`::${opts.key}`));
    if (!keys.length) throw new UsageError(`no check runs of ${opts.key} in the last 24 hours`);
  }
  const items = keys.map((k) => { const p = progress(recs, k); return { key: k, command: p.command, counts: p.counts, signal: p.signal, runs: p.runs.map((r) => r.id) }; });
  if (ctx.json) { ctx.emitJson({ keys: items }); return 0; }
  if (!items.length) { ctx.out('kerb progress · no check runs in the last 24 hours\n'); return 0; }
  for (const i of items) ctx.out(`${i.command}: ${series(i.counts)}${i.signal ? ` (${i.signal})` : ''}\n`);
  return 0;
}
