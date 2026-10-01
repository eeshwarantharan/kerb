// Retention for kept states (KERB-V2 4.2): keep the last 20 states per key, every state that was
// green in the last 14 days, and every state a fix or finding refers to. Everything else loses
// its ref and state file (git reclaims the objects in its own gc); walk-mode blobs no kept state
// uses are deleted, and worktrees left by jobs are removed.
import fs from 'node:fs';
import path from 'node:path';
import { buildRuns } from '../store/jsonl.js';
import { isSuccess } from '../loop/rules.js';
import { readJson } from '../util/fsx.js';
import { git } from './snapshot.js';
import { REF_PREFIX, stateRefs, statePath } from './keep.js';
import { removeWorktree } from './materialize.js';

export const KEEP_PER_KEY = 20;
export const GREEN_DAYS = 14;
const STALE_WORKTREE_MS = 60 * 60_000;
const isState = (s) => typeof s === 'string' && /^st_[0-9a-f]+$/.test(s);

/** The state ids retention keeps. */
export function keptStates(recs, nowTs) {
  const keep = new Set();
  const runs = buildRuns(recs).filter((r) => r.finished && isState(r.post_hash)).sort((a, b) => (a.end_ts ?? a.ts) - (b.end_ts ?? b.ts));
  const byKey = new Map();
  for (const r of runs) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    const list = byKey.get(r.key);
    const i = list.indexOf(r.post_hash);
    if (i !== -1) list.splice(i, 1);
    list.push(r.post_hash);
  }
  for (const list of byKey.values()) for (const id of list.slice(-KEEP_PER_KEY)) keep.add(id);
  const from = nowTs - GREEN_DAYS * 86_400_000;
  for (const r of runs) if (isSuccess(r) && (r.end_ts ?? r.ts) >= from) keep.add(r.post_hash);
  for (const r of recs) {
    if (r.type !== 'fix' && r.type !== 'finding') continue;
    for (const k of ['from_state', 'to_state', 'good_state', 'bad_state']) if (isState(r[k])) keep.add(r[k]);
  }
  return keep;
}

/**
 * @param {string} root
 * @param {any[]} recs the event log
 * @param {number} nowTs
 * @param {{ dryRun?: boolean, git?: boolean }} [o]
 */
export function gcStates(root, recs, nowTs, o = {}) {
  const keep = keptStates(recs, nowTs);
  const dir = path.join(root, '.kerb', 'states');
  let files = [];
  try { files = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { /* none */ }
  const refs = o.git ? stateRefs(root) : [];
  const drop = [...new Set([...files, ...refs])].filter((id) => !keep.has(id)).sort();
  const out = { kept: [...keep].filter((id) => files.includes(id) || refs.includes(id)).length, removed: drop, blobs_removed: 0, worktrees_removed: 0 };
  if (o.dryRun) return out;
  const dropRefs = drop.filter((id) => refs.includes(id));
  if (dropRefs.length) git(root, ['update-ref', '--stdin'], { input: dropRefs.map((id) => `delete ${REF_PREFIX}${id}\n`).join('') });
  for (const id of drop) fs.rmSync(statePath(root, id), { force: true });
  // Walk-mode blobs: keep what any remaining state refers to.
  const blobsDir = path.join(root, '.kerb', 'blobs');
  if (fs.existsSync(blobsDir)) {
    const used = new Set();
    for (const id of files.filter((x) => !drop.includes(x))) {
      const s = readJson(statePath(root, id), null);
      if (s && s.files) for (const f of Object.values(s.files)) used.add(f.h);
    }
    for (const sub of fs.readdirSync(blobsDir)) {
      for (const n of fs.readdirSync(path.join(blobsDir, sub))) {
        if (!used.has(`${sub}${n}`)) { fs.rmSync(path.join(blobsDir, sub, n), { force: true }); out.blobs_removed++; }
      }
    }
  }
  // Temporary indexes left by a snapshot that was killed mid-way.
  const tmp = path.join(root, '.kerb', 'tmp');
  try {
    for (const n of fs.readdirSync(tmp)) {
      const p = path.join(tmp, n);
      try { if (nowTs - fs.statSync(p).mtimeMs > STALE_WORKTREE_MS) fs.rmSync(p, { force: true }); } catch { /* gone */ }
    }
  } catch { /* none */ }
  const wt = path.join(root, '.kerb', 'worktrees');
  let jobs = [];
  try { jobs = fs.readdirSync(wt); } catch { /* none */ }
  for (const j of jobs) {
    const p = path.join(wt, j);
    try {
      if (nowTs - fs.statSync(p).mtimeMs < STALE_WORKTREE_MS) continue;
    } catch { continue; }
    removeWorktree(root, p);
    out.worktrees_removed++;
  }
  return out;
}
