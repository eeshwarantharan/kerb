// Git-mode workspace hash (4.7.2): tree id of the scope at HEAD plus the dirty set from
// `git status`, which compares index stat data (including ctime) and uses fsmonitor and the
// untracked cache when the repo enables them.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { crypto } from '../util/lazy.js';
import { HashBudgetError, checkDeadline, hashPath, sha } from './hashfile.js';

function git(root, args, deadline) {
  const timeout = deadline ? Math.max(1, deadline - Date.now()) : 10_000;
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'buffer', timeout, maxBuffer: 256 * 1024 * 1024 });
  if (r.error && r.error.code === 'ETIMEDOUT') throw new HashBudgetError();
  if (r.signal === 'SIGTERM' && deadline && Date.now() >= deadline) throw new HashBudgetError();
  return r;
}

/**
 * Pathspecs for the scope (relative to the repo root). The whole repo uses none: any
 * pathspec, even ".", stops git from using its untracked cache.
 */
function pathspecs(scope) {
  if (scope.whole) return [];
  return ['--', scope.pkgRel, ...scope.shared, ...scope.sharedGlobs.map((g) => `:(glob)${g}`)];
}

/**
 * Parse `git status --porcelain=v2 -z` output into [{ path, status }].
 * @param {Buffer} buf
 */
export function parseStatusV2(buf) {
  const parts = buf.toString('utf8').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const t = e[0];
    if (t === '#') continue;
    if (t === '1') {
      const f = e.split(' ');
      out.push({ path: f.slice(8).join(' '), status: f[1], sub: f[2] });
    } else if (t === '2') {
      const f = e.split(' ');
      out.push({ path: f.slice(9).join(' '), status: f[1], sub: f[2], from: parts[i + 1] });
      i++;
    } else if (t === 'u') {
      const f = e.split(' ');
      out.push({ path: f.slice(10).join(' '), status: f[1], sub: f[2] });
    } else if (t === '?') {
      out.push({ path: e.slice(2), status: '??' });
    }
  }
  return out;
}

/**
 * @param {string} root
 * @param {import('./scope.js').Scope} scope
 * @param {{ deadline?: number, ignore?: (p: string, d?: boolean) => boolean }} o
 */
export function gitWorkspace(root, scope, o = {}) {
  const { deadline, ignore = () => false } = o;
  // Base: tree of the scope at HEAD plus blob ids of the root shared files.
  const base = { tree: null, blobs: {}, globs: null };
  if (scope.whole) {
    // Filled from `git status --branch` below (the HEAD commit), saving a git spawn.
  } else {
    const r = git(root, ['ls-tree', '-z', 'HEAD', '--', scope.pkgRel, ...scope.shared], deadline);
    if (r.status === 0) {
      for (const ent of r.stdout.toString('utf8').split('\0')) {
        if (!ent) continue;
        const tab = ent.indexOf('\t');
        const [, type, oid] = ent.slice(0, tab).split(' ');
        const p = ent.slice(tab + 1);
        if (p === scope.pkgRel && type === 'tree') base.tree = oid;
        else base.blobs[p] = oid;
      }
    }
    if (!base.tree) base.tree = r.status === 0 ? 'absent' : 'nohead';
    if (scope.sharedGlobs.length) {
      const g = git(root, ['ls-files', '-s', '-z', '--', ...scope.sharedGlobs.map((x) => `:(glob)${x}`)], deadline);
      base.globs = g.status === 0 ? crypto().createHash('sha256').update(g.stdout).digest('hex') : null;
    }
  }
  checkDeadline(deadline);
  // -unormal (not -uall) so the untracked cache applies; untracked directories are
  // expanded below with ls-files, which honours the same ignore rules.
  const st = git(root, ['status', '--porcelain=v2', '-z', '--untracked-files=normal', ...(scope.whole ? ['--branch'] : []), ...pathspecs(scope)], deadline);
  if (st.status !== 0) throw new Error(`git status failed: ${st.stderr.toString().trim()}`);
  if (scope.whole) {
    const m = /(?:^|\0)# branch\.oid ([^\0\s]+)/.exec(st.stdout.toString('utf8'));
    base.tree = m && m[1] !== '(initial)' ? m[1] : 'nohead';
  }
  const isKerb = (p) => p === '.kerb/' || p.startsWith('.kerb/');
  let entries = parseStatusV2(st.stdout).filter((e) => !isKerb(e.path));
  const untrackedDirs = entries.filter((e) => e.status === '??' && e.path.endsWith('/')).map((e) => e.path);
  if (untrackedDirs.length) {
    checkDeadline(deadline);
    const ls = git(root, ['ls-files', '-z', '-o', '--exclude-standard', '--', ...untrackedDirs], deadline);
    entries = entries.filter((e) => !(e.status === '??' && e.path.endsWith('/')));
    if (ls.status === 0) {
      for (const p of ls.stdout.toString('utf8').split('\0')) if (p && !isKerb(p)) entries.push({ path: p, status: '??' });
    }
  }
  entries = entries.filter((e) => !ignore(e.path));
  /** @type {Record<string, { st: string, x: number, h: string }>} */
  const dirty = {};
  const composites = [];
  for (const e of entries) {
    checkDeadline(deadline);
    const info = hashPath(path.join(root, e.path));
    let rec;
    if (!info) rec = { st: e.status, x: 0, h: 'deleted' };
    else if (info.h === 'dir') rec = { st: e.status, x: 0, h: `sub:${e.sub || ''}` };
    else rec = { st: e.status, x: info.x, h: info.h };
    dirty[e.path] = rec;
    composites.push(rec.h === 'deleted' ? sha(e.path, 'deleted') : sha(e.path, rec.st, rec.x, rec.h));
  }
  composites.sort();
  const baseStr = JSON.stringify([base.tree, Object.entries(base.blobs).sort(), base.globs]);
  const hash = sha(baseStr, ...composites).slice(0, 32);
  return { hash, snapshot: { mode: 'git', scope: scope.pkgRel, base, dirty } };
}

/** Content hash (sha256) of a path in a tree, or 'absent'. */
export function blobContentHash(root, treeish, rel) {
  const spec = rel == null ? treeish : `${treeish}:${rel}`;
  const r = spawnSync('git', ['-C', root, 'cat-file', 'blob', spec], { maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return 'absent';
  return crypto().createHash('sha256').update(r.stdout).digest('hex');
}

/** Paths that differ between two trees (relative to the trees). */
export function treeDiff(root, a, b) {
  const r = spawnSync('git', ['-C', root, 'diff-tree', '-r', '-z', '--name-only', '--no-renames', a, b], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter(Boolean);
}
