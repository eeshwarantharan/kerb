// Small shared helpers: exit codes, errors, clock, ids, durations, sizes, hashing.
import { createHash, randomBytes } from 'node:crypto';

/** Exit codes (4.2). Loop and policy codes are configurable by the human or managed config. */
export const EXIT = {
  USAGE: 64,
  INTERNAL: 70,
  CORRUPT: 71,
  TIMEOUT: 124,
  IDLE: 125,
  get LOOP() { return envCode('KERB_EXIT_LOOP', 75); },
  get POLICY() { return envCode('KERB_EXIT_POLICY', 77); },
};

function envCode(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 && v < 256 ? v : fallback;
}

export class KerbError extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class UsageError extends KerbError {
  constructor(message) { super(EXIT.USAGE, message); }
}

// Injectable clock, so time-based rules can be tested.
let clock = () => Date.now();
export function now() { return clock(); }
/** @param {(() => number) | null} fn */
export function setClock(fn) { clock = fn || (() => Date.now()); }

let lastIdTs = 0;
let seq = 0;
/** Sortable, time-based id: 9 base-36 chars of time, 2 of sequence, 3 random. */
export function newId(ts = now()) {
  if (ts === lastIdTs) seq++;
  else { lastIdTs = ts; seq = 0; }
  const t = Math.floor(ts).toString(36).padStart(9, '0');
  const s = (seq % 1296).toString(36).padStart(2, '0');
  const r = randomBytes(2).readUInt16BE(0).toString(36).padStart(3, '0').slice(-3);
  return `${t}${s}${r}`;
}

/** @param {string | Buffer} data */
export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

const DUR_RE = /^(\d+(?:\.\d+)?)(ms|s|sec|secs|m|min|mins|h|hr|hrs)?$/;
/**
 * Parse "500ms", "30s", "5m", "1.5h"; a bare number is seconds.
 * @param {string | number} v
 * @returns {number} milliseconds
 */
export function parseDuration(v) {
  if (typeof v === 'number') return v * 1000;
  const m = DUR_RE.exec(String(v).trim());
  if (!m) throw new UsageError(`invalid duration: ${v}`);
  const n = Number(m[1]);
  const unit = m[2] || 's';
  if (unit === 'ms') return Math.round(n);
  if (unit.startsWith('s')) return Math.round(n * 1000);
  if (unit.startsWith('m')) return Math.round(n * 60_000);
  return Math.round(n * 3_600_000);
}

/** @param {number} ms */
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1).replace(/\.0$/, '') : Math.round(s)}s`;
  const total = Math.round(s);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const r = total % 60;
  if (h) return `${h}h ${m}m`;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/** @param {number} n bytes */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${trim1(n / 1000)} KB`;
  if (n < 1_000_000_000) return `${trim1(n / 1_000_000)} MB`;
  return `${trim1(n / 1_000_000_000)} GB`;
}

/** @param {number} n */
export function formatCount(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trim1(n / 1000)}k`;
  return `${trim1(n / 1_000_000)}M`;
}

function trim1(x) {
  return x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, '');
}

/** True if a process with this PID exists. */
export function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Convert a simple glob (only `*` and `?`) to an anchored RegExp. */
export function globToRegExp(glob, { star = '.*' } = {}) {
  let re = '';
  for (const ch of glob) {
    if (ch === '*') re += star;
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.+^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const isWindows = process.platform === 'win32';
