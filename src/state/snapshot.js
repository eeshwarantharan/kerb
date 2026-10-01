// State snapshots (KERB-V2 4.1). A state is the content of a check command's scope plus its env
// stamp. In git mode the content is a git tree written through a temporary copy of the index,
// so states are content-addressed by git and restorable; outside git it is v1's walk hash, with
// file contents kept in a content-addressed blob store under .kerb/blobs/.
//
// Git mode, per call:
//   1. `git status` (v1's command, so fsmonitor and the untracked cache still apply) gives the
//      dirty paths in scope, minus .kerb/ and .kerbignore matches.
//   2. Nothing dirty: the snapshot is HEAD's tree. Otherwise copy the index to
//      .kerb/tmp/index-<pid>-<n>, `git update-index --add --remove` only the dirty paths (which
//      writes their blobs), and `git write-tree`. Same tree as `git add -A` would give, without
//      rescanning the whole repo; the real index is never touched.
//   3. state_id = "st_" + sha256(scope subtree id ‖ shared blob ids ‖ env stamp ‖ HEAD commit)[0..16].
//      HEAD is included so a commit makes a retry legitimate, as in v1 (W16); see the decisions
//      log in docs/KERB-V2.md. Diffs and restores compare trees, so content still decides those.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { crypto } from '../util/lazy.js';
import { ensureDir } from '../util/fsx.js';
import zlib from 'node:zlib';
import { HashBudgetError, checkDeadline, hashPath, sha } from '../loop/hashfile.js';
import { parseStatusV2 } from '../loop/workspace-git.js';
import { walkWorkspace } from '../loop/workspace-walk.js';

/** Files over this size are hashed but their content is not stored (4.1). */
export const MAX_STORED = 5 * 1024 * 1024;
let seq = 0;

export function git(root, args, { deadline, env, input, encoding = 'buffer' } = {}) {
  const timeout = deadline ? Math.max(1, deadline - Date.now()) : 30_000;
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: encoding === 'buffer' ? undefined : encoding, timeout, input, maxBuffer: 256 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env,
  });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new HashBudgetError();
  if (r.signal === 'SIGTERM' && deadline && Date.now() >= deadline) throw new HashBudgetError();
  return r;
}

export function stateId(...parts) {
  return `st_${sha(...parts).slice(0, 16)}`;
}

function pathspecs(scope) {
  if (scope.whole) return [];
  return ['--', scope.pkgRel, ...scope.shared, ...scope.sharedGlobs.map((g) => `:(glob)${g}`)];
}

/** Dirty paths in scope from `git status`, with untracked directories expanded. */
function dirtyEntries(root, scope, deadline, ignore) {
  const st = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', '--branch', ...pathspecs(scope)], { deadline });
  if (st.status !== 0) throw new Error(`git status failed: ${st.stderr.toString().trim()}`);
  const m = /(?:^|\0)# branch\.oid ([^\0\s]+)/.exec(st.stdout.toString('utf8'));
  const head = m && m[1] !== '(initial)' ? m[1] : null;
  const isKerb = (p) => p === '.kerb/' || p.startsWith('.kerb/');
  let entries = parseStatusV2(st.stdout).filter((e) => !isKerb(e.path));
  const untrackedDirs = entries.filter((e) => e.status === '??' && e.path.endsWith('/')).map((e) => e.path);
  if (untrackedDirs.length) {
    checkDeadline(deadline);
    const ls = git(root, ['ls-files', '-z', '-o', '--exclude-standard', '--', ...untrackedDirs], { deadline });
    entries = entries.filter((e) => !(e.status === '??' && e.path.endsWith('/')));
    if (ls.status === 0) for (const p of ls.stdout.toString('utf8').split('\0')) if (p && !isKerb(p)) entries.push({ path: p, status: '??' });
  }
  return { entries: entries.filter((e) => !ignore(e.path)), head };
}

/** Git directory (worktrees and `gitdir:` files resolved). */
function gitDir(root) {
  const dotgit = path.join(root, '.git');
  try {
    if (fs.statSync(dotgit).isFile()) {
      const m = /^gitdir: (.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
      if (m) return path.resolve(root, m[1].trim());
    }
  } catch { /* fall through */ }
  return dotgit;
}

/**
 * Tree id of a commit, read from its loose object when there is one (no git spawn), else null.
 * New commits stay loose until git packs them.
 */
export function looseCommitTree(root, oid) {
  if (!/^[0-9a-f]{40}$/.test(oid || '')) return null;
  for (const dir of [gitDir(root), commonDir(root)]) {
    try {
      const raw = zlib.inflateSync(fs.readFileSync(path.join(dir, 'objects', oid.slice(0, 2), oid.slice(2))));
      const m = /^commit \d+\0tree ([0-9a-f]{40})\n/.exec(raw.subarray(0, 120).toString('latin1'));
      if (m) return m[1];
    } catch { /* packed, or not here */ }
  }
  return null;
}

function commonDir(root) {
  const g = gitDir(root);
  try { return path.resolve(g, fs.readFileSync(path.join(g, 'commondir'), 'utf8').trim()); } catch { return g; }
}

/** Subtree id and shared-file blob ids of the scope inside a tree (or HEAD). */
function scopeIds(root, treeish, scope, deadline) {
  if (scope.whole) {
    const r = git(root, ['rev-parse', '--verify', '-q', `${treeish}^{tree}`], { deadline, encoding: 'utf8' });
    return { subtree: r.status === 0 ? r.stdout.trim() : 'empty', blobs: {} };
  }
  const r = git(root, ['ls-tree', '-z', treeish, '--', scope.pkgRel, ...scope.shared], { deadline });
  const out = { subtree: 'absent', blobs: {} };
  if (r.status !== 0) return { subtree: 'empty', blobs: {} };
  for (const ent of r.stdout.toString('utf8').split('\0')) {
    if (!ent) continue;
    const tab = ent.indexOf('\t');
    const [, type, oid] = ent.slice(0, tab).split(' ');
    const p = ent.slice(tab + 1);
    if (p === scope.pkgRel && type === 'tree') out.subtree = oid;
    else out.blobs[p] = oid;
  }
  return out;
}

/**
 * Git-mode state.
 * @param {string} root
 * @param {import('../loop/scope.js').Scope} scope
 * @param {{ deadline?: number, ignore?: (p: string, d?: boolean) => boolean, envStamp?: string }} o
 */
export function gitState(root, scope, o = {}) {
  const { deadline, ignore = () => false, envStamp = '' } = o;
  const { entries, head } = dirtyEntries(root, scope, deadline, ignore);
  checkDeadline(deadline);
  // A retry with nothing touched since the last snapshot: reuse it without rebuilding the tree.
  const cacheKey = entries.length ? stateCacheKey(root, scope, head, envStamp, entries) : null;
  if (cacheKey) {
    const hit = stateCacheGet(root, cacheKey.key);
    if (hit) return { hash: hit.id, snapshot: hit };
  }
  let tree = null;
  let materializable = true;
  let globIndex = null;
  let treeish = null;
  if (!entries.length) {
    if (scope.whole && head) {
      tree = looseCommitTree(root, head);
      if (!tree) {
        const h = git(root, ['rev-parse', '--verify', '-q', `${head}^{tree}`], { deadline, encoding: 'utf8' });
        tree = h.status === 0 ? h.stdout.trim() : null;
      }
    } else if (head) treeish = head; // the full tree is resolved only if this state is kept (keep.js)
  } else {
    const tmpDir = ensureDir(path.join(root, '.kerb', 'tmp'));
    const index = path.join(tmpDir, `index-${process.pid}-${++seq}-${crypto().randomBytes(3).toString('hex')}`);
    const realIndex = gitIndexPath(root);
    try {
      try {
        const st = fs.statSync(realIndex);
        fs.copyFileSync(realIndex, index);
        // Git trusts an entry's stat data unless the entry is as new as the index file ("racy").
        // A fresh copy is newer than every entry, which would let update-index skip a file edited
        // within the same timestamp as the index; giving the copy the real index's mtime
        // (truncated down) keeps the racy set what `git status` saw, and update-index treats
        // racy entries as dirty.
        fs.utimesSync(index, st.atime, st.mtime);
      } catch { /* no index yet: start empty */ }
      const env = { GIT_INDEX_FILE: index };
      const small = [];
      const large = [];
      for (const e of entries) {
        let size = 0;
        try {
          const st = fs.lstatSync(path.join(root, e.path));
          if (st.isDirectory()) continue; // a submodule or nested repository: left as recorded
          size = st.size;
        } catch { /* deleted: --remove takes it out */ }
        (size > MAX_STORED ? large : small).push(e.path);
      }
      if (small.length) {
        const u = git(root, ['update-index', '--add', '--remove', '-z', '--stdin'], { deadline, env, input: `${small.join('\0')}\0` });
        if (u.status !== 0) throw new Error(`git update-index failed: ${u.stderr.toString().trim()}`);
      }
      if (large.length) {
        // Hashed but not stored: the tree is exact, the state can't be materialized.
        const u = git(root, ['update-index', '--add', '--remove', '--info-only', '-z', '--stdin'], { deadline, env, input: `${large.join('\0')}\0` });
        if (u.status !== 0) throw new Error(`git update-index failed: ${u.stderr.toString().trim()}`);
        materializable = false;
      }
      checkDeadline(deadline);
      const w = git(root, ['write-tree', ...(large.length ? ['--missing-ok'] : [])], { deadline, env, encoding: 'utf8' });
      if (w.status !== 0) throw new Error(`git write-tree failed: ${w.stderr.trim()}`);
      tree = w.stdout.trim();
      if (scope.sharedGlobs.length) globIndex = index;
    } finally {
      if (!globIndex) fs.rmSync(index, { force: true });
    }
  }
  const ids = tree || treeish ? (scope.whole && tree ? { subtree: tree, blobs: {} } : scopeIds(root, tree || treeish, scope, deadline)) : { subtree: 'empty', blobs: {} };
  let globs = null;
  if (scope.sharedGlobs.length) {
    const g = git(root, ['ls-files', '-s', '-z', '--', ...scope.sharedGlobs.map((x) => `:(glob)${x}`)], { deadline, env: globIndex ? { GIT_INDEX_FILE: globIndex } : undefined });
    globs = g.status === 0 ? crypto().createHash('sha256').update(g.stdout).digest('hex') : null;
    if (globIndex) fs.rmSync(globIndex, { force: true });
  }
  const id = stateId(ids.subtree, JSON.stringify(Object.entries(ids.blobs).sort()), globs || '', envStamp, head || 'nohead');
  const snapshot = { mode: 'git', id, scope: scope.pkgRel, shared: scope.whole ? [] : [...scope.shared], tree, treeish, subtree: ids.subtree, head, env_stamp: envStamp, materializable, dirty: entries.length };
  if (cacheKey && cacheKey.trustable) stateCachePut(root, cacheKey.key, snapshot);
  return { hash: id, snapshot };
}

const CACHE_FILE = 'state-cache.json';
const CACHE_MAX = 64;
const RACY_NS = 2_000_000_000n;

/**
 * Key for the state cache: HEAD, scope, env stamp, and every dirty path with its full stat.
 * Trustable only when every dirty file was at least 2 s old when the key was made, so any later
 * write must change its mtime (the same rule git uses for racily clean index entries).
 */
function stateCacheKey(root, scope, head, envStamp, entries) {
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  let trustable = true;
  const parts = [head || '', scope.pkgRel, ...scope.shared, ...scope.sharedGlobs, envStamp];
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    let st = null;
    try { st = fs.lstatSync(path.join(root, e.path), { bigint: true }); } catch { /* deleted */ }
    if (st && (st.mtimeNs > nowNs - RACY_NS || st.ctimeNs > nowNs - RACY_NS)) trustable = false;
    parts.push(e.path, e.status, st ? `${st.ino}:${st.size}:${st.mode}:${st.mtimeNs}:${st.ctimeNs}` : 'deleted');
  }
  return { key: sha(...parts), trustable };
}

function stateCacheGet(root, key) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, '.kerb', CACHE_FILE), 'utf8'));
    return c[key] || null;
  } catch { return null; }
}

function stateCachePut(root, key, snapshot) {
  const file = path.join(root, '.kerb', CACHE_FILE);
  let c = {};
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new */ }
  delete c[key];
  c[key] = snapshot;
  const keys = Object.keys(c);
  for (const k of keys.slice(0, Math.max(0, keys.length - CACHE_MAX))) delete c[k];
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { /* a cache */ }
}

/** The repo's index file (worktrees keep theirs in their own git dir). */
export function gitIndexPath(root) {
  return path.join(gitDir(root), 'index');
}

/**
 * Walk-mode state: v1's walk hash, plus the env stamp. Contents are stored when `store` is set.
 */
export function walkState(root, scope, o = {}) {
  const { deadline, ignore, envStamp = '', store = false } = o;
  const r = walkWorkspace(root, scope, { deadline, ignore });
  let materializable = true;
  const files = r.snapshot.files;
  // Contents (and the over-5 MB check) only for states that are kept; ids need neither.
  if (store) for (const [rel, f] of Object.entries(files)) {
    let size = 0;
    try { size = fs.lstatSync(path.join(root, rel)).size; } catch { /* gone */ }
    if (size > MAX_STORED) { materializable = false; f.big = 1; continue; }
    if (store) storeBlob(root, path.join(root, rel), f.h);
  }
  const id = stateId(r.hash, envStamp);
  return { hash: id, snapshot: { mode: 'walk', id, scope: scope.pkgRel, files, env_stamp: envStamp, materializable } };
}

export function blobPath(root, h) {
  return path.join(root, '.kerb', 'blobs', h.slice(0, 2), h.slice(2));
}

/** Copy a file's content into the blob store under its sha256 (no-op when already there). */
export function storeBlob(root, file, h) {
  const dest = blobPath(root, h);
  if (fs.existsSync(dest)) return;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return;
    ensureDir(path.dirname(dest));
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(file, tmp);
    fs.renameSync(tmp, dest);
  } catch { /* the file changed or vanished; the state stays hashable, just not restorable */ }
}
