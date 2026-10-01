// kerb review-shadow [--since 7d] [-n N]: every command shadow mode would have stopped, with its
// evidence and what happened when it ran anyway (KERB-V2 10.2).
import { findRoot } from '../util/repo.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { now, parseDuration, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';

const LOOP = new Set(['identical_retry', 'deja_vu', 'breaker_open']);

/**
 * What happened when the command ran anyway: the first run of the same key that started at or
 * after the would-refuse event.
 */
export function outcomeOf(ev, runs) {
  const next = runs.find((r) => r.key === ev.key && r.ts >= ev.ts - 1000 && r.finished);
  if (!next) return { text: 'no recorded run followed', run: null, verdict: null };
  if (next.exit === 0) {
    return {
      text: `ran anyway and passed (exit 0)${LOOP.has(ev.reason) ? '; this refusal would have been wrong, please report it' : ''}`,
      run: next.id,
      verdict: LOOP.has(ev.reason) ? 'would_have_been_wrong' : null,
    };
  }
  const matched = ev.matched_run ? runs.find((r) => r.id === ev.matched_run) : null;
  const same = matched && matched.fingerprint && matched.fingerprint === next.fingerprint;
  return {
    text: `ran anyway: exit ${next.exit ?? '?'}${same ? ', the same failure as before' : ''}`,
    run: next.id,
    verdict: same ? 'same_result' : null,
  };
}

export default async function reviewShadow(ctx, args) {
  const { opts } = parseOpts(args, { since: 'string', n: 'string' }, { n: 'n' });
  let fromTs = 0;
  if (opts.since) {
    try { fromTs = now() - parseDuration(opts.since); } catch { throw new UsageError(`--since takes a duration like 7d (got ${opts.since})`); }
  }
  const n = opts.n ? Number(opts.n) : 50;
  if (!Number.isInteger(n) || n < 1) throw new UsageError('-n takes a positive whole number');
  const { root } = findRoot(ctx.cwd);
  const recs = new Store(root).read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const runs = buildRuns(recs);
  const all = recs.filter((r) => r.type === 'would_refuse' && r.ts >= fromTs);
  const events = all.slice(-n).map((ev) => ({ ...ev, outcome: outcomeOf(ev, runs) }));
  if (ctx.json) {
    ctx.emitJson({ total: all.length, events });
    return 0;
  }
  if (!all.length) {
    ctx.out('kerb review-shadow · shadow mode has not stopped anything yet\n');
    return 0;
  }
  ctx.out(`kerb review-shadow · ${all.length} command${all.length === 1 ? '' : 's'} Kerb would have stopped${events.length < all.length ? ` (latest ${events.length} shown)` : ''}\n`);
  for (const ev of events) {
    const t = new Date(ev.ts).toISOString().replace('T', ' ').slice(0, 16);
    ctx.out(`\n${t}  ${ev.reason}  ${ev.cmd}\n`);
    ctx.out(`      ${ev.summary}\n`);
    if (ev.evidence) ctx.out(`      ${ev.evidence}\n`);
    ctx.out(`      then: ${ev.outcome.text}\n`);
  }
  const wrong = events.filter((e) => e.outcome.verdict === 'would_have_been_wrong').length;
  ctx.out(`\n${wrong ? `${wrong} of these passed when run anyway; check them before turning blocking on. ` : ''}Turn blocking on: kerb enforce (in your own terminal)\n`);
  return 0;
}
