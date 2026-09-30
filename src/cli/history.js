// kerb history [-n N] [--key K]: recent runs and refusals, newest first.
import { findRoot } from '../util/repo.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { formatDuration, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';

export function historyEntries(recs, { n = 20, key = null } = {}) {
  const runs = buildRuns(recs).map((r) => ({
    kind: r.is_wait ? 'wait' : 'run', id: r.id, ts: r.finished ? r.end_ts : r.ts, key: r.key, class: r.class, exit: r.exit ?? null,
    result: r.is_wait ? r.result : r.finished ? r.class_result : 'running', duration_ms: r.duration_ms ?? null, attempts: r.attempts, cmd: r.cmd,
  }));
  const refusals = recs.filter((r) => r.type === 'refusal').map((r) => ({ kind: 'refusal', id: r.id, ts: r.ts, key: r.key, reason: r.reason, matched_run: r.matched_run, cmd: r.cmd }));
  return [...runs, ...refusals].filter((e) => !key || e.key === key || (e.key && e.key.endsWith(`::${key}`))).sort((a, b) => b.ts - a.ts).slice(0, n);
}

export default async function history(ctx, args) {
  const { opts } = parseOpts(args, { n: 'string', key: 'string' }, { n: 'n' });
  const n = opts.n ? Number(opts.n) : 20;
  if (!Number.isInteger(n) || n < 1) throw new UsageError('-n takes a positive whole number');
  const { root } = findRoot(ctx.cwd);
  const entries = historyEntries(new Store(root).read(), { n, key: opts.key || null });
  if (ctx.json) { ctx.emitJson({ entries }); return 0; }
  if (!entries.length) { ctx.out('kerb history · nothing recorded yet\n'); return 0; }
  for (const e of entries) {
    const t = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
    const what = e.kind === 'refusal'
      ? `refused ${e.reason}`
      : e.kind === 'wait'
        ? `wait ${e.result} after ${e.attempts} attempts, exit ${e.exit}`
        : `${e.class} ${e.result === 'running' ? 'running' : `exit ${e.exit ?? '?'} ${e.result}`} ${e.duration_ms != null ? formatDuration(e.duration_ms) : ''}`;
    ctx.out(`${t}  ${e.id}  ${what.trim()}  ${e.key}\n`);
  }
  return 0;
}
