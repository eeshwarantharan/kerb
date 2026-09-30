// Content hashing for workspace files. Files over 5 MB hash size + first and last 1 MB.
import fs from 'node:fs';
import { crypto } from '../util/lazy.js';

const BIG = 5 * 1024 * 1024;
const EDGE = 1024 * 1024;

export class HashBudgetError extends Error {
  constructor() { super('hash budget exceeded'); }
}

/** Throw if the deadline has passed. */
export function checkDeadline(deadline) {
  if (deadline && Date.now() > deadline) throw new HashBudgetError();
}

/**
 * Content hash and exec bit of a path; null if it doesn't exist.
 * @returns {{ h: string, x: 0 | 1, st: fs.Stats } | null}
 */
export function hashPath(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  const x = process.platform !== 'win32' && (st.mode & 0o111) ? 1 : 0;
  if (st.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(file); } catch { /* */ }
    return { h: crypto().createHash('sha256').update(`link:${target}`).digest('hex'), x: 0, st };
  }
  if (st.isDirectory()) return { h: 'dir', x: 0, st };
  const hash = crypto().createHash('sha256');
  if (st.size > BIG) {
    const fd = fs.openSync(file, 'r');
    try {
      const a = Buffer.alloc(EDGE);
      const b = Buffer.alloc(EDGE);
      fs.readSync(fd, a, 0, EDGE, 0);
      fs.readSync(fd, b, 0, EDGE, st.size - EDGE);
      hash.update(String(st.size)).update(a).update(b);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    try { hash.update(fs.readFileSync(file)); } catch { return null; }
  }
  return { h: hash.digest('hex'), x, st };
}

export function sha(...parts) {
  const h = crypto().createHash('sha256');
  parts.forEach((p, i) => { if (i) h.update('\0'); h.update(String(p)); });
  return h.digest('hex');
}
