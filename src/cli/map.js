// kerb map: every boundary with source, status, hits and expiry.
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { LIFETIME_MS } from '../bound/learn.js';
import { now } from '../util/core.js';
import { parseOpts } from './args.js';
import { refreshOrgIfDue } from '../engine.js';

export function boundaryHits(recs) {
  /** @type {Record<string, number>} */
  const hits = {};
  for (const r of recs) if (r.type === 'refusal' && r.boundary) hits[r.boundary] = (hits[r.boundary] || 0) + 1;
  return hits;
}

export function mapEntries(root) {
  const nowTs = now();
  const store = new Store(root);
  let recs = [];
  try { recs = store.read(); } catch { recs = []; }
  const hits = boundaryHits(recs);
  const policy = loadPolicy(root, loadConfig(), nowTs);
  const rows = policy.boundaries.map((b) => ({
    kind: b.kind,
    pattern: b.pattern,
    source: b.source,
    layer: b.layer,
    status: b.layer === 'learned' ? 'confirmed' : 'policy',
    alternative: b.alternative || null,
    why: b.why || null,
    hits: b.layer === 'learned' && b.entry ? b.entry.hits : hits[`${b.kind}:${b.pattern}`] || 0,
    expires: b.layer === 'learned' && b.entry ? b.entry.last_seen + LIFETIME_MS : null,
  }));
  for (const e of policy.suspected || []) {
    rows.push({ kind: 'host', pattern: e.pattern, source: 'learned from a policy denial', layer: 'learned', status: 'suspected', alternative: null, why: null, hits: e.hits, expires: e.last_seen + LIFETIME_MS });
  }
  return { rows, policy };
}

export default async function map(ctx, args) {
  parseOpts(args, {});
  await refreshOrgIfDue();
  const { root } = findRoot(ctx.cwd);
  const { rows, policy } = mapEntries(root);
  if (ctx.json) {
    ctx.emitJson({ boundaries: rows, layers: policy.layers });
    return 0;
  }
  if (!rows.length) {
    ctx.out('kerb map · no boundaries known here (add kerb.policy.json, or Kerb learns them from policy denials)\n');
    return 0;
  }
  ctx.out(`kerb map · ${rows.length} boundar${rows.length === 1 ? 'y' : 'ies'}\n`);
  for (const r of rows) {
    const bits = [`${r.kind} ${r.pattern}`, r.status === 'suspected' ? 'suspected (never blocks)' : r.source];
    if (r.alternative) bits.push(`use ${r.alternative}`);
    bits.push(`${r.hits} hit${r.hits === 1 ? '' : 's'}`);
    if (r.expires) bits.push(`expires ${new Date(r.expires).toISOString().slice(0, 10)}`);
    ctx.out(`  ${bits.join(' · ')}\n`);
    if (r.why) ctx.out(`      ${r.why}\n`);
  }
  return 0;
}
