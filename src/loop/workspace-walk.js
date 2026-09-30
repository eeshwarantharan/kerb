// Walk-mode workspace hash (outside git): walk the scope, cache content hashes by
// size, mtimeMs, ctimeMs and inode in .kerb/wscache.json.
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, readJson } from '../util/fsx.js';
import { checkDeadline, hashPath, sha } from './hashfile.js';
import { globPathRegExp } from '../util/ignore.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '.kerb']);

/**
 * @param {string} root
 * @param {import('./scope.js').Scope} scope
 * @param {{ deadline?: number, ignore?: (p: string, d?: boolean) => boolean, cacheFile?: string }} o
 */
export function walkWorkspace(root, scope, o = {}) {
  const { deadline, ignore = () => false } = o;
  const cacheFile = o.cacheFile || path.join(root, '.kerb', 'wscache.json');
  const cache = readJson(cacheFile, {}) || {};
  let cacheDirty = false;
  /** @type {Record<string, { x: number, h: string }>} */
  const files = {};
  let n = 0;

  const visitFile = (abs, rel) => {
    if ((++n & 63) === 0) checkDeadline(deadline);
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    const c = cache[rel];
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && c.ctimeMs === st.ctimeMs && c.ino === st.ino) {
      files[rel] = { x: c.x, h: c.h };
      return;
    }
    const info = hashPath(abs);
    if (!info) return;
    files[rel] = { x: info.x, h: info.h };
    cache[rel] = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, x: info.x, h: info.h };
    cacheDirty = true;
  };
  const walk = (absDir, relDir) => {
    let ents;
    try { ents = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || ignore(rel, true)) continue;
        walk(path.join(absDir, e.name), rel);
      } else {
        if (ignore(rel, false)) continue;
        visitFile(path.join(absDir, e.name), rel);
      }
    }
  };

  if (scope.whole) walk(root, '');
  else {
    walk(scope.pkgRoot, scope.pkgRel);
    for (const s of scope.shared) if (!ignore(s)) visitFile(path.join(root, s), s);
    for (const g of scope.sharedGlobs) {
      const re = globPathRegExp(g);
      const parts = g.split('/');
      const firstWild = parts.findIndex((x) => /[*?]/.test(x));
      const staticDir = (firstWild === -1 ? parts.slice(0, -1) : parts.slice(0, firstWild)).join('/');
      const before = new Set(Object.keys(files));
      walk(path.join(root, staticDir), staticDir);
      for (const k of Object.keys(files)) if (!before.has(k) && !re.test(k)) delete files[k];
    }
  }
  // Forget cache entries for files that no longer exist in this scope.
  for (const k of Object.keys(cache)) {
    if (!(k in files) && (scope.whole || k.startsWith(`${scope.pkgRel}/`)) && !fs.existsSync(path.join(root, k))) {
      delete cache[k];
      cacheDirty = true;
    }
  }
  if (cacheDirty) {
    try { atomicWrite(cacheFile, JSON.stringify(cache)); } catch { /* cache is an optimisation */ }
  }
  const per = Object.keys(files).sort().map((p) => sha(p, files[p].x, files[p].h));
  return { hash: sha(...per).slice(0, 32), snapshot: { mode: 'walk', scope: scope.pkgRel, files } };
}
