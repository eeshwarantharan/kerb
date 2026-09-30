// Append-only record store (4.9, 4.14): crc per line, exclusive lock, torn-write repair,
// corruption detection, rotation.
import fs from 'node:fs';
import path from 'node:path';
import { EXIT, KerbError, now, pidAlive } from '../util/core.js';
import { ensureDir, logError } from '../util/fsx.js';
import { applyRecords, loadSummary, writeSummary } from './summary.js';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 (IEEE) of a string's UTF-8 bytes or a Buffer. */
export function crc32(data) {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** One record line: `{…fields, "crc": <crc32 of the JSON without crc>}`. */
export function encodeRecord(rec) {
  const json = JSON.stringify(rec);
  return `${json.slice(0, -1)}${json.length > 2 ? ',' : ''}"crc":${crc32(json)}}`;
}

const CRC_TAIL = /,?"crc":(\d+)\}$/;
/** Parse and verify one line; null if torn or corrupt. */
export function decodeRecord(line) {
  const m = CRC_TAIL.exec(line);
  if (!m) return null;
  const body = `${line.slice(0, m.index)}}`;
  if (crc32(body) !== Number(m[1])) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

const sab = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sab, 0, 0, ms); }

export const DEFAULTS = {
  rotateBytes: 50 * 1024 * 1024,
  readTailBytes: 8 * 1024 * 1024,
  lockWaitMs: 2000,
  staleLockMs: 30_000,
};

export class Store {
  /**
   * @param {string} root repo root; state lives in <root>/.kerb
   * @param {Partial<typeof DEFAULTS>} [opts]
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.dir = path.join(root, '.kerb');
    this.file = path.join(this.dir, 'runs.jsonl');
    this.opts = { ...DEFAULTS, ...opts };
  }

  ensure() {
    ensureDir(this.dir);
    return this;
  }

  get lockPath() { return path.join(this.dir, 'lock'); }

  /** Run fn while holding .kerb/lock. After lockWaitMs, runs anyway (appends are O_APPEND) and logs it. */
  withLock(fn) {
    this.ensure();
    const deadline = Date.now() + this.opts.lockWaitMs;
    let fd = null;
    for (;;) {
      try {
        fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeSync(fd, `${process.pid} ${Date.now()}`);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        if (this.breakStaleLock()) continue;
        if (Date.now() >= deadline) {
          logError('lock', new Error('lock wait exceeded; writing without lock'));
          break;
        }
        sleepSync(5 + Math.floor(Math.random() * 20));
      }
    }
    try {
      return fn();
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
        try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
      }
    }
  }

  /** Remove the lock if its holder is dead or it is older than staleLockMs. */
  breakStaleLock() {
    try {
      const st = fs.statSync(this.lockPath);
      const [pidStr] = fs.readFileSync(this.lockPath, 'utf8').split(' ');
      const pid = Number(pidStr);
      const stale = Date.now() - st.mtimeMs > this.opts.staleLockMs;
      const dead = pidStr !== '' && Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
      if (stale || dead) {
        fs.unlinkSync(this.lockPath);
        return true;
      }
    } catch {
      // Lock vanished between checks: retry immediately.
      return true;
    }
    return false;
  }

  /**
   * Append records under the lock, then refresh summary.json.
   * @param {object[]} recs
   * @param {(summary: any) => void} [tweak] extra summary changes made under the same lock
   */
  append(recs, tweak) {
    this.withLock(() => {
      const data = recs.map((r) => `${encodeRecord(r)}\n`).join('');
      if (data) fs.appendFileSync(this.file, data, { mode: 0o600 });
      const summary = loadSummary(this.dir);
      applyRecords(summary, recs, now());
      if (tweak) tweak(summary);
      writeSummary(this.dir, summary);
      if (data) this.maybeRotate();
    });
  }

  /** Change summary.json only (counters that aren't records). */
  updateSummary(tweak) {
    this.withLock(() => {
      const summary = loadSummary(this.dir);
      tweak(summary);
      writeSummary(this.dir, summary);
    });
  }

  maybeRotate() {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.opts.rotateBytes) return;
    const n = this.rotatedFiles().reduce((m, f) => Math.max(m, f.n), 0) + 1;
    fs.renameSync(this.file, path.join(this.dir, `runs.${n}.jsonl`));
  }

  /** Rotated files, oldest first. */
  rotatedFiles() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names
      .map((f) => /^runs\.(\d+)\.jsonl$/.exec(f))
      .filter(Boolean)
      .map((m) => ({ n: Number(m[1]), file: path.join(this.dir, m[0]) }))
      .sort((a, b) => a.n - b.n);
  }

  /**
   * Read records: the previous rotated file plus the current one, newest data last.
   * Reads at most readTailBytes from the end (older records are dropped, which only ever
   * means fewer refusals). A bad last line is a torn write and is truncated; a bad line
   * anywhere else throws exit 71 and changes nothing.
   * @param {{ maxBytes?: number, repair?: boolean }} [o]
   * @returns {object[]}
   */
  read({ maxBytes = this.opts.readTailBytes, repair = true } = {}) {
    const files = [];
    const prev = this.rotatedFiles().pop();
    if (prev) files.push({ file: prev.file, current: false });
    files.push({ file: this.file, current: true });
    let budget = maxBytes;
    const chunks = [];
    for (const f of files.reverse()) {
      if (budget <= 0) break;
      let size;
      try { size = fs.statSync(f.file).size; } catch { continue; }
      const start = Math.max(0, size - budget);
      budget -= size - start;
      const buf = Buffer.alloc(size - start);
      const fd = fs.openSync(f.file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
      chunks.unshift({ ...f, text: buf.toString('utf8'), start });
    }
    const out = [];
    for (const c of chunks) {
      let lines = c.text.split('\n');
      let offset = c.start;
      if (c.start > 0) {
        // Drop the partial first line of a tail read.
        offset += Buffer.byteLength(lines[0]) + 1;
        lines = lines.slice(1);
      }
      const hasTrailingNewline = c.text.endsWith('\n');
      if (hasTrailingNewline) lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const rec = line ? decodeRecord(line) : null;
        if (rec) {
          out.push(rec);
          offset += Buffer.byteLength(line) + 1;
          continue;
        }
        const isLast = c.current && i === lines.length - 1;
        if (isLast) {
          if (repair) this.truncateTorn(offset);
          break;
        }
        throw new KerbError(EXIT.CORRUPT,
          `state corrupt: ${path.relative(this.root, c.file)} line ${lineNumberAt(c.file, offset)} is damaged; nothing was changed. Move the file aside or fix that line.`);
      }
    }
    return out;
  }

  truncateTorn(offset) {
    this.withLock(() => {
      try {
        const size = fs.statSync(this.file).size;
        if (size > offset) fs.truncateSync(this.file, offset);
      } catch { /* nothing to repair */ }
    });
  }
}

function lineNumberAt(file, offset) {
  try {
    const buf = fs.readFileSync(file);
    let n = 1;
    for (let i = 0; i < offset && i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch {
    return '?';
  }
}

/**
 * Join start/end records into runs (and fold `wait` records in as runs).
 * @param {any[]} recs
 */
export function buildRuns(recs) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const runs = [];
  for (const r of recs) {
    if (r.type === 'start') {
      const run = { ...r, finished: false };
      byId.set(r.id, run);
      runs.push(run);
    } else if (r.type === 'end') {
      const run = byId.get(r.id);
      if (run) {
        const { ts, type, ...rest } = r;
        Object.assign(run, rest, { end_ts: ts, finished: true });
      }
    } else if (r.type === 'wait') {
      runs.push({ ...r, finished: true, end_ts: r.ts, is_wait: true });
    }
  }
  return runs;
}
