// kerb green [--key K] [--test T] [--json]: the newest state where a check (or one test) passed,
// when, and what changed since (KERB-V2 7.5).
import { UsageError } from '../util/core.js';
import { prepare } from '../engine.js';
import { lastGreen, resolveKey, endTs } from '../insight/green.js';
import { currentState, changedSince } from '../insight/verify.js';
import { hhmm } from '../insight/ledger.js';
import { parseOpts } from './args.js';

export default async function green(ctx, args) {
  const { opts } = parseOpts(args, { key: 'string', test: 'string' });
  const prep = prepare(ctx, { command: 'true', reap: false });
  const recs = prep.store.read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const key = resolveKey(recs, opts.key);
  if (opts.key && !key) throw new UsageError(`no check runs of ${opts.key} in this repo`);
  if (!key && !opts.test) {
    if (ctx.json) ctx.emitJson({ green: null });
    else ctx.out('kerb green · no check runs recorded yet\n');
    return 0;
  }
  const g = lastGreen(prep.root, recs, { key: opts.test ? (opts.key ? key : null) : key, test: opts.test || null });
  if (!g) {
    if (ctx.json) ctx.emitJson({ green: null, key, test: opts.test || null });
    else ctx.out(`kerb green · ${opts.test ? `${opts.test} has` : `${key.slice(key.indexOf('::') + 2)} has`} not passed on a kept state\n`);
    return 0;
  }
  let changed = [];
  try { changed = changedSince(prep.root, g.state.id, currentState(prep.root, prep.git, g.key, prep.policy, ctx.env), 50); } catch { changed = []; }
  const when = endTs(g.run);
  if (ctx.json) {
    ctx.emitJson({ green: { key: g.key, test: g.test, state: g.state.id, run: g.run.id, ts: when, materializable: !!g.state.materializable, changed_since: changed } });
    return 0;
  }
  const what = g.test || g.key.slice(g.key.indexOf('::') + 2);
  ctx.out(`kerb green · ${what} · passed at ${new Date(when).toISOString().slice(0, 10)} ${hhmm(when)} (run ${g.run.id}) · ${g.state.id}\n`);
  ctx.out(changed.length ? `  changed since: ${changed.join(', ')}\n` : '  nothing in its scope has changed since\n');
  if (changed.length) ctx.out(`  restore: kerb restore ${g.state.id} --patch\n`);
  return 0;
}
