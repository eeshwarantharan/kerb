// Workspace state for a check command: scope, hash (git or walk mode), env stamp, snapshots.
import fs from 'node:fs';
import path from 'node:path';
import { loadKerbignore } from '../util/ignore.js';
import { computeScope } from './scope.js';
import { blobContentHash, treeDiff } from './workspace-git.js';
import { gitState, walkState } from '../state/snapshot.js';
import { keepState, readState, diffStates } from '../state/keep.js';
import { envStamp } from './envstamp.js';
import { HashBudgetError } from './hashfile.js';

let slowHasherForTests = 0;
/** Tests only: add an artificial delay (ms) to every hash computation. */
export function setHashDelayForTests(ms) { slowHasherForTests = ms; }

/**
 * Compute the state id (KERB-V2 4.1) within a budget. `hash` is the state id; `snapshot` is
 * what keepState() needs to keep it. v1 callers and records call it the workspace hash.
 * @param {{ root: string, git: boolean, policy: any, env: NodeJS.ProcessEnv, envStamp?: string, store?: boolean }} ctx
 *   envStamp: folded into the state id; store: walk mode copies contents into the blob store
 * @param {import('./scope.js').Scope} scope
 * @param {number} budgetMs
 * @returns {{ hash: string | null, snapshot: any, skipped: string | null, ms: number }}
 */
export function hashWorkspace(ctx, scope, budgetMs) {
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  try {
    if (slowHasherForTests) {
      const sab = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, slowHasherForTests);
      if (Date.now() > deadline) throw new HashBudgetError();
    }
    const ignore = loadKerbignore(ctx.root);
    const o = { deadline, ignore, envStamp: ctx.envStamp || '', store: !!ctx.store };
    const r = ctx.git ? gitState(ctx.root, scope, o) : walkState(ctx.root, scope, o);
    return { ...r, skipped: null, ms: Date.now() - t0 };
  } catch (e) {
    if (e instanceof HashBudgetError) return { hash: null, snapshot: null, skipped: 'hash_budget', ms: Date.now() - t0 };
    throw e;
  }
}

/**
 * Scope + env stamp for the command's check segment.
 * @param {any} prep engine prep
 * @param {string} segCwd
 */
export function scopeAndStamp(prep, segCwd) {
  const scope = computeScope(prep.root, segCwd, prep.policy);
  const stamp = envStamp(prep.ctx.env, prep.policy, [scope.pkgRoot, prep.root]);
  return { scope, envStamp: stamp };
}

export function snapshotPath(store, id) {
  return path.join(store.dir, 'snapshots', `${id}.json`);
}

/** Keep a run's post-state (state file, commit and ref) and log a `state` record if it is new. */
export function writeSnapshot(store, runId, snapshot) {
  if (!snapshot) return;
  void runId;
  const rec = keepState(path.dirname(store.dir), snapshot, Date.now());
  if (rec) store.ensure().append([rec]);
}

/**
 * The kept state of a run (by its post-state id), falling back to a v1 snapshot file by run id.
 * @param {any} store
 * @param {{ id: string, post_hash?: string | null } | string} run a run, or a state id
 */
export function readSnapshot(store, run) {
  const root = path.dirname(store.dir);
  const stateId = typeof run === 'string' ? run : run && run.post_hash;
  const st = readState(root, stateId);
  if (st) return st;
  const runId = typeof run === 'string' ? run : run && run.id;
  try { return JSON.parse(fs.readFileSync(snapshotPath(store, runId), 'utf8')); } catch { return null; }
}

/**
 * Files that differ between two snapshots.
 * @returns {string[] | null} null when snapshots are missing or incomparable
 */
export function diffSnapshots(root, a, b) {
  if (!a || !b || a.mode !== b.mode) return null;
  if (a.id && b.id) return diffStates(root, a, b);
  if (a.id || b.id) return null;
  if (a.mode === 'walk') {
    const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
    return [...keys].filter((k) => {
      const x = a.files[k];
      const y = b.files[k];
      return !x || !y || x.h !== y.h || x.x !== y.x;
    }).sort();
  }
  const changed = new Set();
  const cand = new Set([...Object.keys(a.dirty), ...Object.keys(b.dirty)]);
  const prefix = a.scope && a.scope !== '.' ? `${a.scope}/` : '';
  const sameBase = a.base.tree === b.base.tree;
  if (!sameBase && a.base.tree && b.base.tree && !['nohead', 'absent'].includes(a.base.tree) && !['nohead', 'absent'].includes(b.base.tree)) {
    const d = treeDiff(root, a.base.tree, b.base.tree);
    if (d) for (const p of d) cand.add(prefix + p);
  }
  for (const p of new Set([...Object.keys(a.base.blobs || {}), ...Object.keys(b.base.blobs || {})])) {
    if ((a.base.blobs || {})[p] !== (b.base.blobs || {})[p]) cand.add(p);
  }
  const contentAt = (snap, p) => {
    const d = snap.dirty[p];
    if (d) return `${d.h}:${d.x}`;
    if (snap.base.blobs && p in snap.base.blobs) return blobContentHash(root, snap.base.blobs[p], null);
    if (!snap.base.tree || ['nohead', 'absent'].includes(snap.base.tree)) return 'absent';
    const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p;
    return blobContentHash(root, snap.base.tree, rel);
  };
  for (const p of cand) {
    if (sameBase && !(p in a.dirty) && !(p in b.dirty) && (a.base.blobs || {})[p] === (b.base.blobs || {})[p]) continue;
    const x = contentAt(a, p);
    const y = contentAt(b, p);
    if (x.split(':')[0] !== y.split(':')[0] || (x.includes(':') && y.includes(':') && x !== y)) changed.add(p);
  }
  return [...changed].sort();
}
