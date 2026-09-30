// kerb status: tier per agent, boundaries in effect, open breakers, last 5 runs, session
// totals, coverage (4.1, 4.10.3).
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { readJson } from '../util/fsx.js';
import { now, formatDuration } from '../util/core.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { loadSummary, currentSession } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { MANIFEST } from '../init/install.js';
import { AGENT_DESCRIPTORS } from '../init/agents.js';
import { keyHistory, isSuccess } from '../loop/rules.js';
import { parseOpts } from './args.js';
import { historyEntries } from './history.js';

/** Keys whose latest loop refusal was breaker_open, with no success, ack or reset since. */
export function openBreakers(recs) {
  const latest = new Map();
  for (const r of recs) if (r.type === 'refusal' && r.reason === 'breaker_open') latest.set(r.key, r);
  const out = [];
  for (const [key, ref] of latest) {
    const { keyRuns } = keyHistory(recs, key);
    const cleared = keyRuns.some((r) => isSuccess(r) && (r.end_ts ?? r.ts) > ref.ts)
      || recs.some((r) => (r.type === 'ack' || r.type === 'reset') && (!r.key || r.key === key) && r.ts > ref.ts);
    if (!cleared) out.push({ key, since: ref.ts, refusal: ref.id });
  }
  return out;
}

export default async function status(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  let recs = [];
  try { recs = store.read(); } catch (e) { recs = []; if (!ctx.json) ctx.err(`kerb: note · ${e.message}\n`); }
  const summary = loadSummary(store.dir);
  const manifest = readJson(path.join(root, MANIFEST), null);
  const policy = loadPolicy(root, loadConfig(), now());
  const names = Object.fromEntries(AGENT_DESCRIPTORS.map((d) => [d.id, d.name]));
  const agents = Object.entries((manifest && manifest.agents) || {}).map(([id, a]) => {
    const h = (summary.hooks || {})[id] || null;
    return { id, name: names[id] || id, tier: a.tier, how: a.how, observed: h ? h.pre : 0, fully_recorded: h ? h.full || 0 : 0, coverage: h && h.pre ? (h.full || 0) / h.pre : null };
  });
  const session = currentSession(summary);
  const runs = buildRuns(recs).filter((r) => r.finished);
  const breakers = openBreakers(recs);
  const last = historyEntries(recs, { n: 5 });
  const bySource = {};
  for (const b of policy.boundaries) bySource[b.source] = (bySource[b.source] || 0) + 1;
  const skips = runs.filter((r) => r.loop_skipped === 'hash_budget').length;
  const enforced = agents.some((a) => a.tier === 'enforced');

  if (ctx.json) {
    ctx.emitJson({
      root, agents, best_effort_note: enforced ? null : 'Kerb only sees commands run through kerb run.',
      boundaries: { total: policy.boundaries.length, by_source: bySource, suspected: (policy.suspected || []).length },
      org: policy.org, open_breakers: breakers, last_runs: last, session, hash_budget_skips: skips, errors: summary.errors || 0,
    });
    return 0;
  }
  ctx.out(`kerb status · ${root}\n`);
  ctx.out('agents\n');
  if (!agents.length) ctx.out('  none wired in (run kerb init)\n');
  const w = Math.max(10, ...agents.map((a) => a.name.length));
  for (const a of agents) {
    const cov = a.tier === 'enforced' && a.coverage != null ? ` · ${Math.round(a.coverage * 100)}% of ${a.observed} observed commands fully recorded` : '';
    ctx.out(`  ${a.name.padEnd(w)}  ${a.tier} (${a.how})${cov}\n`);
  }
  if (!enforced) ctx.out('  best effort: Kerb only sees commands run through kerb run.\n');
  ctx.out(`  loop checks skipped for the hash budget: ${skips}\n`);
  const src = Object.entries(bySource).map(([s, n]) => `${n} from ${s}`).join(', ');
  ctx.out(`boundaries  ${policy.boundaries.length} in effect${src ? ` (${src})` : ''}${policy.suspected && policy.suspected.length ? `, ${policy.suspected.length} suspected` : ''}\n`);
  if (policy.org) {
    const o = policy.org;
    ctx.out(`org policy  ${o.version != null ? `v${o.version}` : 'no verified bundle'}${o.offline ? ' · offline, using the cached bundle' : ''}${o.stale ? ' · cache expired, still in use' : ''}${o.last_error ? ` · last fetch: ${o.last_error}` : ''}\n`);
  }
  ctx.out(`open breakers  ${breakers.length ? '' : 'none'}\n`);
  for (const b of breakers) ctx.out(`  ${b.key} (since ${new Date(b.since).toISOString().slice(11, 19)}; the user can run kerb ack)\n`);
  ctx.out('last runs\n');
  if (!last.length) ctx.out('  none yet\n');
  for (const e of last) {
    const what = e.kind === 'refusal' ? `refused ${e.reason}` : `${e.class} exit ${e.exit ?? '?'}${e.duration_ms != null ? ` ${formatDuration(e.duration_ms)}` : ''}`;
    ctx.out(`  ${new Date(e.ts).toISOString().slice(11, 19)}  ${what}  ${e.key}\n`);
  }
  const c = session.counters;
  ctx.out(`session  ${c.runs} runs · ${c.refusals} refusals · ${c.reruns_avoided} re-runs avoided · ${c.polls_folded} polls folded · ${c.hangs_killed} hangs killed${session.tier ? ` · ${session.tier}` : ''}\n`);
  if (summary.errors) ctx.out(`errors  ${summary.errors} internal errors logged (hooks failed open); run kerb doctor\n`);
  return 0;
}
