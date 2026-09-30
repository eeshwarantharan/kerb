// In-flight run tracking and orphan reaping (4.5.5), kept apart from the supervisor so
// pre-checks and hooks don't load child_process.
import fs from 'node:fs';
import path from 'node:path';
import { isWindows, pidAlive } from '../util/core.js';
import { ensureDir } from '../util/fsx.js';
import { childProcess } from '../util/lazy.js';

export const KILL_GRACE_MS = 3000;

/** True if any process in the group still exists. */
export function groupAlive(pgid) {
  if (!pgid) return false;
  if (isWindows) return pidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Synchronous variant for orphan reaping at start-up. */
export function killTreeSync(pgid, grace = KILL_GRACE_MS) {
  if (!pgid) return;
  if (isWindows) {
    childProcess().spawnSync('taskkill', ['/pid', String(pgid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  const sab = new Int32Array(new SharedArrayBuffer(4));
  const end = Date.now() + grace;
  while (Date.now() < end) {
    Atomics.wait(sab, 0, 0, 50);
    if (!groupAlive(pgid)) return;
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
}

// ---------------------------------------------------------------------------
// In-flight runs, for orphan reaping (4.5.5). One small file per running command.

export function activeDir(store) { return path.join(store.dir, 'active'); }

export function markActive(store, info) {
  const dir = ensureDir(activeDir(store));
  fs.writeFileSync(path.join(dir, `${info.id}.json`), JSON.stringify(info), { mode: 0o600 });
}

export function clearActive(store, id) {
  try { fs.unlinkSync(path.join(activeDir(store), `${id}.json`)); } catch { /* already gone */ }
}

/** In-flight runs (other than our own) whose Kerb process is still alive. */
export function activeRuns(store) {
  let names = [];
  try { names = fs.readdirSync(activeDir(store)); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(activeDir(store), n), 'utf8'));
      if (pidAlive(info.kerb_pid)) out.push(info);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * For every in-flight run whose Kerb process is dead: record it as aborted and kill its
 * process group if it still exists. Covers Kerb itself being SIGKILLed.
 * @param {import('../store/jsonl.js').Store} store
 * @param {(info: any) => object} endRecord builds the `end` record for an orphan
 */
export function reapOrphans(store, endRecord) {
  let names = [];
  try { names = fs.readdirSync(activeDir(store)); } catch { return 0; }
  let reaped = 0;
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = path.join(activeDir(store), n);
    let info;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { try { fs.unlinkSync(file); } catch { /* */ } continue; }
    if (pidAlive(info.kerb_pid)) continue;
    // Claim it first so two Kerb processes don't both reap it.
    try { fs.unlinkSync(file); } catch { continue; }
    if (info.pgid && groupAlive(info.pgid)) killTreeSync(info.pgid);
    store.append([endRecord(info)]);
    reaped++;
  }
  return reaped;
}

