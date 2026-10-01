// Kept states (KERB-V2 4.2): every check run's post-state is recorded, and in git mode kept
// alive by a commit object and a ref under refs/kerb/states/, which default push refspecs never
// send. .kerb/states/<id>.json holds what Kerb needs to compare and restore a state.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, ensureDir, readJson } from '../util/fsx.js';
import { git } from './snapshot.js';

export const REF_PREFIX = 'refs/kerb/states/';
// Deterministic, identity-free commits: a user without user.name/email (or with signing on)
// must not break or prompt.
const COMMIT_ENV = {
  GIT_AUTHOR_NAME: 'kerb', GIT_AUTHOR_EMAIL: 'kerb@localhost', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'kerb', GIT_COMMITTER_EMAIL: 'kerb@localhost', GIT_COMMITTER_DATE: '@0 +0000',
};

export function statePath(root, id) {
  return path.join(root, '.kerb', 'states', `${id}.json`);
}

export function readState(root, id) {
  if (!id || !/^st_[0-9a-f]+$/.test(id)) return null;
  return readJson(statePath(root, id), null);
}

/**
 * Keep a state: write .kerb/states/<id>.json and, in git mode, its commit and ref.
 * Returns the `state` event record when the state is new, else null.
 * @param {string} root
 * @param {any} snapshot from gitState() / walkState()
 */
export function keepState(root, snapshot, nowTs) {
  if (!snapshot || !snapshot.id) return null;
  const file = statePath(root, snapshot.id);
  if (fs.existsSync(file)) return null;
  const s = { ...snapshot };
  if (s.mode === 'git') {
    if (!s.tree && s.treeish) {
      const r = git(root, ['rev-parse', '--verify', '-q', `${s.treeish}^{tree}`], { encoding: 'utf8' });
      s.tree = r.status === 0 ? r.stdout.trim() : null;
    }
    delete s.treeish;
    if (s.tree) {
      const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { encoding: 'utf8' });
      const parent = head.status === 0 ? ['-p', head.stdout.trim()] : [];
      const c = git(root, ['-c', 'commit.gpgSign=false', 'commit-tree', s.tree, ...parent, '-m', `kerb state ${s.id}`], { env: COMMIT_ENV, encoding: 'utf8' });
      if (c.status === 0) {
        s.commit = c.stdout.trim();
        git(root, ['update-ref', `${REF_PREFIX}${s.id}`, s.commit]);
      }
    }
  }
  ensureDir(path.dirname(file));
  atomicWrite(file, JSON.stringify(s));
  return {
    type: 'state', id: s.id, ts: nowTs, mode: s.mode, scope: s.scope, snapshot_tree: s.tree || null, commit: s.commit || null,
    env_stamp: s.env_stamp || null, materializable: !!s.materializable,
  };
}

/** Files that differ between two kept states (repo-relative), or null if incomparable. */
export function diffStates(root, a, b) {
  if (!a || !b || a.mode !== b.mode) return null;
  if (a.mode === 'walk') {
    const keys = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
    return [...keys].filter((k) => {
      const x = a.files[k];
      const y = b.files[k];
      return !x || !y || x.h !== y.h || x.x !== y.x;
    }).sort();
  }
  if (!a.tree || !b.tree) return null;
  const specs = new Set();
  let whole = false;
  for (const s of [a, b]) {
    if (s.scope === '.' || !s.scope) whole = true;
    else { specs.add(s.scope); for (const f of s.shared || []) specs.add(f); }
  }
  const r = git(root, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', a.tree, b.tree, ...(whole ? [] : ['--', ...specs])], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean).sort();
}

/** All kept state ids that have a ref. */
export function stateRefs(root) {
  const r = git(root, ['for-each-ref', '--format=%(refname)', REF_PREFIX], { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').filter(Boolean).map((x) => x.slice(REF_PREFIX.length));
}

/** A snapshot's full tree id (resolving a lazily recorded HEAD tree), or null. */
export function treeOf(root, snapshot) {
  if (!snapshot) return null;
  if (snapshot.tree) return snapshot.tree;
  if (!snapshot.treeish) return null;
  const r = git(root, ['rev-parse', '--verify', '-q', `${snapshot.treeish}^{tree}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
