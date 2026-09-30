// File-system helpers: private directories, atomic writes, JSON reads.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Create a directory (and parents) with mode 0700. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Write a file atomically: temp file in the same directory, then rename. Mode 0600. */
export function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read and parse JSON; return `fallback` when missing or unparsable. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The per-user Kerb directory (~/.kerb), created with mode 0700 on demand. */
export function homeKerbDir({ create = true } = {}) {
  const dir = path.join(os.homedir(), '.kerb');
  if (create) ensureDir(dir);
  return dir;
}

/** Append one line to ~/.kerb/errors.log; never throws. */
export function logError(where, err) {
  try {
    const dir = homeKerbDir();
    const line = `${new Date().toISOString()} ${where} ${err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err)}\n`;
    fs.appendFileSync(path.join(dir, 'errors.log'), line, { mode: 0o600 });
  } catch {
    // Fail open: error logging must never break a command.
  }
}
