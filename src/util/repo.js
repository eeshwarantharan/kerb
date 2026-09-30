// Locate the repository root and Kerb's state directory without spawning git.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Find the repo root for `cwd`: the nearest ancestor containing `.git`.
 * Outside git, the nearest ancestor containing `.kerb` or `kerb.policy.json`, else `cwd`.
 * @param {string} cwd
 * @returns {{ root: string, git: boolean }}
 */
export function findRoot(cwd) {
  const start = path.resolve(cwd);
  let fallback = null;
  let dir = start;
  for (;;) {
    if (isGitMarker(path.join(dir, '.git'))) return { root: dir, git: true };
    if (!fallback && (isDir(path.join(dir, '.kerb')) || isFile(path.join(dir, 'kerb.policy.json')))) fallback = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: fallback || start, git: false };
}

function isGitMarker(p) {
  try {
    const st = fs.statSync(p);
    return st.isDirectory() || st.isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** Path relative to the root, with forward slashes; '.' for the root itself. */
export function relPath(root, p) {
  const r = path.relative(root, p).split(path.sep).join('/');
  return r === '' ? '.' : r;
}
