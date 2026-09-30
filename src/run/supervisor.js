// Supervisor (4.5): spawn in its own process group with stdin at EOF, total and idle
// timeouts that kill the whole tree, signal forwarding, orphan reaping.
import { spawn, spawnSync } from 'node:child_process';
import { isWindows } from '../util/core.js';
import { KILL_GRACE_MS, groupAlive } from './orphans.js';

export { KILL_GRACE_MS };
export { groupAlive, killTreeSync, activeDir, markActive, clearActive, activeRuns, reapOrphans } from './orphans.js';

const DRAIN_MS = 500;

/**
 * @typedef {{ exit: number | null, signal: string | null, reason: 'exit' | 'timeout' | 'idle' | 'aborted',
 *   durationMs: number, pid: number | undefined, pgid: number | undefined, abortSignal?: string }} SuperviseResult
 */

/**
 * Run a shell command, supervised. stdout and stderr are merged at the child so their
 * interleaving is exact; every chunk goes to onData.
 * @param {string} command
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, idleMs?: number,
 *   onData?: (b: Buffer) => void, onSpawn?: (info: { pid: number, pgid: number }) => void,
 *   killGraceMs?: number }} o
 * @returns {{ done: Promise<SuperviseResult>, abort: (signal: string) => void }}
 */
export function supervise(command, o) {
  const started = Date.now();
  const grace = o.killGraceMs ?? KILL_GRACE_MS;
  const child = isWindows
    ? spawn(command, { cwd: o.cwd, env: o.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    : spawn('/bin/sh', ['-c', 'exec /bin/sh -c "$1" 2>&1', 'sh', command], {
      cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  const pid = child.pid;
  const pgid = pid;
  /** @type {SuperviseResult['reason']} */
  let reason = 'exit';
  let abortSignal;
  let killing = null;
  let totalTimer = null;
  let idleTimer = null;

  const clearTimers = () => {
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    totalTimer = idleTimer = null;
  };
  const stop = (why) => {
    if (killing) return killing;
    reason = why;
    clearTimers();
    killing = killTree(pid, grace);
    return killing;
  };
  const armIdle = () => {
    if (!o.idleMs) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop('idle'), o.idleMs);
  };

  const done = new Promise((resolve) => {
    let exitInfo = null;
    let streamsOpen = 0;
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      clearTimers();
      if (killing) await killing;
      resolve({
        exit: exitInfo ? exitInfo.code : null,
        signal: exitInfo ? exitInfo.signal : null,
        reason,
        durationMs: Date.now() - started,
        pid,
        pgid,
        abortSignal,
      });
    };
    const onStream = (s) => {
      if (!s) return;
      streamsOpen++;
      s.on('data', (d) => { armIdle(); if (o.onData) o.onData(d); });
      s.on('end', () => { streamsOpen--; if (exitInfo && streamsOpen === 0) finish(); });
      s.on('error', () => {});
    };
    onStream(child.stdout);
    onStream(child.stderr);
    child.on('error', (e) => {
      if (o.onData) o.onData(Buffer.from(`kerb: could not start the command: ${e.message}\n`));
      exitInfo = { code: 127, signal: null };
      finish();
    });
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      if (!killing) clearTimers();
      if (streamsOpen === 0) { finish(); return; }
      // Background grandchildren may hold the pipe open; stop reading after a short drain
      // instead of waiting for them (and never kill them for having exited normally).
      setTimeout(() => {
        for (const s of [child.stdout, child.stderr]) if (s) s.destroy();
        finish();
      }, DRAIN_MS).unref();
    });
  });

  if (pid) {
    if (o.onSpawn) o.onSpawn({ pid, pgid });
    if (o.timeoutMs) totalTimer = setTimeout(() => stop('timeout'), o.timeoutMs);
    armIdle();
  }

  return {
    done,
    abort(signal) {
      abortSignal = signal;
      stop('aborted');
    },
  };
}

/**
 * SIGTERM the process group, wait up to `grace` ms, then SIGKILL it.
 * Resolves once the group is gone or has been killed.
 */
export async function killTree(pgid, grace = KILL_GRACE_MS) {
  if (!pgid) return;
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pgid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try { process.kill(-pgid, 'SIGTERM'); } catch { return; }
  const end = Date.now() + grace;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    if (!groupAlive(pgid)) return;
  }
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
}

/**
 * Background commands are never supervised or shaped: run with the agent's normal
 * stdio and return as soon as the shell returns.
 * @returns {Promise<number>}
 */
export function passthrough(command, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, env, shell: isWindows ? true : '/bin/sh', stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 + (SIGNUMS[signal] || 1) : 1)));
  });
}

export const SIGNUMS = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
