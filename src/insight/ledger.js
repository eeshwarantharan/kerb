// Attempt ledger (KERB-V2 7.4): what was tried, from records only, at most 250 tokens.
//   kerb ledger · branch feat/cart · since 14:02
//     npm test (packages/cart): 4 attempts · failing 5 → 3 → 3 → 3 (stalled)
//     edited across attempts: discount.ts (2, 4), pricing.ts (3)
//     attempt 4 returned to the files of attempt 2
//     last green: 13:40 (st_7f3a) · now: stale
import path from 'node:path';
import { readSnapshot, diffSnapshots } from '../loop/workspace.js';
import { buildRuns } from '../store/jsonl.js';
import { progress, series } from './converge.js';
import { keyRuns, isSuccess, endTs } from './history.js';

export const MAX_BYTES = 250 * 4;
export const WINDOW_MS = 24 * 3600_000;

export const hhmm = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** Check keys with runs since `sinceTs`, most recent first. */
export function recentKeys(recs, sinceTs, sessions = null) {
  const last = new Map();
  for (const r of buildRuns(recs)) {
    if (!r.finished || r.class !== 'check' || endTs(r) < sinceTs) continue;
    if (sessions && !sessions.has(r.session)) continue;
    last.set(r.key, Math.max(last.get(r.key) || 0, endTs(r)));
  }
  return [...last].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/**
 * @param {{ root: string, store: any, recs: any[], nowTs: number, branch: string | null,
 *   verification?: Record<string, any>, maxKeys?: number }} o verification: key → item from verify.js
 * @returns {string} '' when there is nothing recent
 */
export function renderLedger(o) {
  const sinceTs = o.nowTs - WINDOW_MS;
  // Sessions on this branch (when the log knows the branch).
  const onBranch = o.branch ? new Set(o.recs.filter((r) => r.type === 'session' && r.branch === o.branch).map((r) => r.id)) : null;
  const keys = recentKeys(o.recs, sinceTs, onBranch && onBranch.size ? onBranch : null).slice(0, o.maxKeys || 3);
  if (!keys.length) return '';
  const firstTs = Math.min(...keys.map((k) => endTs(keyRuns(o.recs, k).find((r) => endTs(r) >= sinceTs))));
  const lines = [`kerb ledger${o.branch ? ` · branch ${o.branch}` : ''} · since ${hhmm(firstTs)}`];
  for (const key of keys) {
    const block = keyBlock(o, key, sinceTs);
    const candidate = [...lines, ...block].join('\n');
    if (Buffer.byteLength(candidate) > MAX_BYTES) {
      const head = [...lines, block[0]].join('\n');
      if (Buffer.byteLength(head) <= MAX_BYTES) lines.push(block[0]);
      break;
    }
    lines.push(...block);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

function keyBlock(o, key, sinceTs) {
  const p = progress(o.recs, key);
  const runs = keyRuns(o.recs, key).filter((r) => endTs(r) >= sinceTs);
  const attempts = p.runs.length;
  const cwd = key.slice(0, key.indexOf('::'));
  const counts = p.counts.some((c) => c != null) ? `failing ${series(p.counts)}` : `${p.runs.filter((r) => !isSuccess(r)).length} failed`;
  const cmd = p.command.length > 60 ? `${p.command.slice(0, 59)}…` : p.command;
  const out = [`  ${cmd}${cwd && cwd !== '.' ? ` (${cwd})` : ''}: ${attempts} attempt${attempts === 1 ? '' : 's'} · ${counts}${p.signal ? ` (${p.signal})` : ''}`];
  // Files edited between attempts, with the attempt numbers where they changed.
  const edits = new Map();
  for (let i = 1; i < p.runs.length; i++) {
    const d = diffSnapshots(o.root, readSnapshot(o.store, p.runs[i - 1]), readSnapshot(o.store, p.runs[i])) || [];
    for (const f of d) { const n = path.basename(f); if (!edits.has(n)) edits.set(n, []); edits.get(n).push(i + 1); }
  }
  if (edits.size) out.push(`  edited across attempts: ${[...edits].slice(0, 5).map(([f, a]) => `${f} (${a.join(', ')})`).join(', ')}`);
  // Returns to an earlier attempt's files.
  for (let i = p.runs.length - 1; i > 0; i--) {
    const j = p.runs.slice(0, i - 1).findIndex((r) => r.post_hash && r.post_hash === p.runs[i].post_hash);
    if (j !== -1) { out.push(`  attempt ${i + 1} returned to the files of attempt ${j + 1}`); break; }
  }
  const green = [...runs].reverse().find(isSuccess) || [...keyRuns(o.recs, key)].reverse().find(isSuccess);
  const v = o.verification && o.verification[key];
  const now = v ? ` · now: ${v.status}` : '';
  if (green) out.push(`  last green: ${hhmm(endTs(green))} (${String(green.post_hash || '').slice(0, 7)})${now}`);
  else if (now) out.push(`  never green yet${now}`);
  return out;
}
