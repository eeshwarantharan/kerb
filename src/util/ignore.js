// A small gitignore-syntax matcher for .kerbignore: `*`, `**`, `?`, trailing `/`, leading `!`, leading `/`.
import fs from 'node:fs';
import path from 'node:path';

export function patternToRegExp(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const slashAfter = p[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '\\' && i + 1 < p.length) re += p[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    else re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return re;
}

/**
 * Compile ignore rules. Returns (relPath, isDir) => ignored. Paths use forward slashes.
 * @param {string} text
 */
export function compileIgnore(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\//, '');
    const body = patternToRegExp(line);
    const re = new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`);
    rules.push({ re, negate, dirOnly });
  }
  if (!rules.length) return () => false;
  const matchOne = (p, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(p)) ignored = !r.negate;
    }
    return ignored;
  };
  return (rel, isDir = false) => {
    // A path is ignored if it, or any parent directory, is ignored.
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (matchOne(parts.slice(0, i).join('/'), true)) return true;
    }
    return matchOne(rel, isDir);
  };
}

/** Load <root>/.kerbignore. */
export function loadKerbignore(root) {
  try {
    return compileIgnore(fs.readFileSync(path.join(root, '.kerbignore'), 'utf8'));
  } catch {
    return () => false;
  }
}

/** Anchored RegExp for a gitignore-style glob over a repo-relative path. */
export function globPathRegExp(glob) {
  return new RegExp(`^${patternToRegExp(glob.replace(/^\//, ''))}$`);
}
