// kerb report [--since 7d] [--estimate]: measured and estimated savings (4.12). Never "turns saved".
import { findRoot } from '../util/repo.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { loadConfig } from '../config.js';
import { now, parseDuration, formatBytes, formatDuration, formatCount, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';

export const DEFAULT_PRICE = 3;

/** Compute the report from records. */
export function computeReport(recs, { fromTs, price = null }) {
  const inWindow = (ts) => ts >= fromTs;
  const all = buildRuns(recs).filter((r) => r.finished);
  const byId = new Map(all.map((r) => [r.id, r]));
  const runs = all.filter((r) => inWindow(r.end_ts));
  const m = {
    runs: runs.length,
    by_class: {},
    by_tier: {},
    refusals: 0,
    refusals_by_reason: {},
    reruns_avoided: 0,
    run_time_avoided_ms: 0,
    output_avoided_bytes: 0,
    output_avoided_tokens_est: 0,
    polls_folded_attempts: 0,
    wait_calls: 0,
    noise_trimmed_bytes: 0,
    hangs_killed: 0,
    walls_confirmed: 0,
    walls_suspected: 0,
    loop_checks: 0,
    hash_budget_skips: 0,
  };
  for (const r of runs) {
    m.by_class[r.class || 'unknown'] = (m.by_class[r.class || 'unknown'] || 0) + 1;
    const tier = r.tier || 'unknown';
    m.by_tier[tier] = (m.by_tier[tier] || 0) + 1;
    m.noise_trimmed_bytes += Math.max(0, (r.raw_bytes || 0) - (r.shown_bytes || 0));
    if (r.class_result === 'timeout' || r.class_result === 'idle') m.hangs_killed++;
    if (r.loop_skipped === 'hash_budget') m.hash_budget_skips++;
    if (r.loop_checked) m.loop_checks++;
    if (r.is_wait) {
      m.wait_calls++;
      m.polls_folded_attempts += Math.max(0, (r.attempts || 1) - 1);
    }
  }
  for (const r of recs) {
    if (!inWindow(r.ts)) continue;
    if (r.type === 'refusal') {
      m.refusals++;
      m.refusals_by_reason[r.reason] = (m.refusals_by_reason[r.reason] || 0) + 1;
      const matched = r.matched_run ? byId.get(r.matched_run) : null;
      if (matched) {
        m.reruns_avoided++;
        m.run_time_avoided_ms += matched.duration_ms || 0;
        m.output_avoided_bytes += matched.shown_bytes || 0;
      }
    } else if (r.type === 'learn') {
      if (r.status === 'confirmed') m.walls_confirmed++;
      else m.walls_suspected++;
    }
  }
  m.output_avoided_tokens_est = Math.round(m.output_avoided_bytes / 4);
  let estimated = null;
  if (price != null) {
    const trimmedTokens = Math.round(m.noise_trimmed_bytes / 4);
    const tokens = m.output_avoided_tokens_est + trimmedTokens;
    estimated = {
      price_per_mtok: price,
      tokens,
      dollars: (tokens * price) / 1e6,
      formula: `(output tokens avoided ${m.output_avoided_tokens_est} + tokens trimmed ${trimmedTokens}) × $${price} per million input tokens`,
      assumptions: [
        '4 bytes per token',
        'output an avoided re-run would have produced is read once as input at the input price',
        'trimmed output would otherwise have been read once as input',
        'a refusal still costs the agent a turn to read it; that cost is not subtracted and no turns are counted as saved',
      ],
    };
  }
  return { measured: m, estimated };
}

export default async function report(ctx, args) {
  const { opts } = parseOpts(args, { since: 'string', estimate: 'bool' });
  const since = opts.since || '7d';
  let windowMs;
  try { windowMs = parseDuration(since); } catch { throw new UsageError(`--since takes a duration like 7d or 24h (got ${since})`); }
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  const recs = store.read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const cfgPrice = loadConfig().values['price.input_per_mtok'];
  const price = cfgPrice != null ? Number(cfgPrice) : opts.estimate ? DEFAULT_PRICE : null;
  const r = computeReport(recs, { fromTs: now() - windowMs, price });
  if (ctx.json) {
    ctx.emitJson({ since, ...r });
    return 0;
  }
  const m = r.measured;
  const list = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  const rows = [
    ['runs', `${m.runs} (${list(m.by_class)}) · ${list(m.by_tier)}`],
    ['refusals', `${m.refusals} (${list(m.refusals_by_reason)})`],
    ['re-runs avoided', String(m.reruns_avoided)],
    ['run time avoided', formatDuration(m.run_time_avoided_ms)],
    ['output avoided', `${formatBytes(m.output_avoided_bytes)} (≈ ${formatCount(m.output_avoided_tokens_est)} tokens, estimated at 4 bytes per token)`],
    ['polls folded', `${m.polls_folded_attempts} attempts in ${m.wait_calls} wait-for call${m.wait_calls === 1 ? '' : 's'}`],
    ['noise trimmed', formatBytes(m.noise_trimmed_bytes)],
    ['hangs killed', String(m.hangs_killed)],
    ['walls learned', `${m.walls_confirmed} confirmed, ${m.walls_suspected} suspected`],
    ['hash-budget skips', `${m.hash_budget_skips} of ${m.loop_checks + m.hash_budget_skips} loop checks`],
  ];
  const w = Math.max(...rows.map((x) => x[0].length));
  ctx.out(`kerb report · last ${since}\n\nMeasured\n`);
  for (const [k, v] of rows) ctx.out(`  ${k.padEnd(w)}  ${v}\n`);
  ctx.out('\nEstimated\n');
  if (!r.estimated) {
    ctx.out('  not shown: set a price with `kerb config set price.input_per_mtok <dollars>`, or pass --estimate ($3 per million input tokens)\n');
  } else {
    const e = r.estimated;
    ctx.out(`  ≈ $${e.dollars.toFixed(e.dollars < 1 ? 4 : 2)} est. input cost avoided\n`);
    ctx.out(`  formula: ${e.formula}\n`);
    ctx.out(`  assumptions: ${e.assumptions.join('; ')}\n`);
  }
  return 0;
}
