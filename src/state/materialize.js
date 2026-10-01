// Materializing a kept state (KERB-V2 4.3), without touching the working tree: a detached git
// worktree under .kerb/worktrees/<job>, a patch from the current state to it, or (walk mode)
// the files restored from the blob store into a directory.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util/fsx.js';
import { git, blobPath } from './snapshot.js';
import { readState } from './keep.js';

export const DEFAULT_WORKTREE_LINKS = ['node_modules', '.venv', 'vendor', 'target'];

function why(reason) {
  return { ok: false, reason };
}

/**
 * A detached worktree at a kept state, with dependency directories symlinked from the main
 * checkout. Refuses when the state can't be materialized or its dependencies differ from now.
 * @param {string} root
 * @param {string} stateId
 * @param {string} job a short name for the worktree directory
 * @param {{ envStamp?: string | null, links?: string[] }} [o] envStamp: the current env stamp
 * @returns {{ ok: true, dir: string, state: any } | { ok: false, reason: string }}
 */
export function worktreeAt(root, stateId, job, o = {}) {
  const state = readState(root, stateId);
  if (!state) return why('state not kept');
  if (!state.materializable) return why('not materializable: it has a file over 5 MB whose content was not stored');
  if (o.envStamp != null && state.env_stamp && o.envStamp !== state.env_stamp) return why('dependencies changed');
  const dir = path.join(root, '.kerb', 'worktrees', job.replace(/[^A-Za-z0-9_.-]/g, '_'));
  if (fs.existsSync(dir)) removeWorktree(root, dir);
  ensureDir(path.dirname(dir));
  if (state.mode === 'walk') {
    const r = restoreWalk(root, state, dir);
    if (!r.ok) return r;
  } else {
    if (!state.commit) return why('state has no commit');
    const r = git(root, ['worktree', 'add', '--detach', '--quiet', dir, state.commit], { encoding: 'utf8' });
    if (r.status !== 0) return why(`git worktree add failed: ${r.stderr.trim()}`);
  }
  linkDependencies(root, dir, state, o.links || DEFAULT_WORKTREE_LINKS);
  return { ok: true, dir, state };
}

/** Symlink dependency directories (repo root and the state's package) into a worktree. */
function linkDependencies(root, dir, state, links) {
  const bases = ['.', ...(state.scope && state.scope !== '.' ? [state.scope] : [])];
  for (const base of bases) {
    for (const name of links) {
      const src = path.join(root, base, name);
      const dest = path.join(dir, base, name);
      if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
      try {
        ensureDir(path.dirname(dest));
        fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
      } catch { /* a job will report what it can't run */ }
    }
  }
}

/** Remove a worktree made by worktreeAt (git or walk). */
export function removeWorktree(root, dir) {
  // Unlink dependency symlinks first, so nothing ever deletes through them.
  const unlinkLinks = (d, depth = 0) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { if (DEFAULT_WORKTREE_LINKS.includes(e.name)) fs.unlinkSync(p); } else if (e.isDirectory() && depth < 4 && e.name !== '.git') unlinkLinks(p, depth + 1);
    }
  };
  unlinkLinks(dir);
  git(root, ['worktree', 'remove', '--force', dir]);
  fs.rmSync(dir, { recursive: true, force: true });
  git(root, ['worktree', 'prune']);
}

/** Write the files of a walk-mode state into `dir`. */
export function restoreWalk(root, state, dir) {
  for (const [rel, f] of Object.entries(state.files || {})) {
    const src = blobPath(root, f.h);
    if (!fs.existsSync(src)) return why(`content of ${rel} is not in the blob store`);
    const dest = path.join(dir, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    if (process.platform !== 'win32') fs.chmodSync(dest, f.x ? 0o755 : 0o644);
  }
  return { ok: true };
}

/**
 * A patch that turns one state into another, limited to the scope (4.3). Nothing is applied.
 * @param {string} root
 * @param {any} from a kept or freshly computed git state (needs `tree`)
 * @param {any} to a kept git state
 * @param {string} out patch path
 */
export function writePatch(root, from, to, out) {
  if (!from || !to || from.mode !== 'git' || to.mode !== 'git' || !from.tree || !to.tree) return why('patches need two git-mode states');
  const specs = to.scope && to.scope !== '.' ? ['--', to.scope, ...(to.shared || [])] : [];
  const r = git(root, ['diff', '--binary', '--no-color', '--no-ext-diff', from.tree, to.tree, ...specs], { encoding: 'utf8' });
  if (r.status !== 0) return why(`git diff failed: ${r.stderr.trim()}`);
  ensureDir(path.dirname(out));
  fs.writeFileSync(out, r.stdout, { mode: 0o600 });
  return { ok: true, path: out, empty: r.stdout.length === 0 };
}
