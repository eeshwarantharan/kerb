// The background worker (KERB-V2 8.1): one per repo (a lock file), started on demand, niced,
// one job at a time within per-job and per-hour budgets, exiting after 60 s idle. It never
// touches the working tree: probes run in worktrees under .kerb/worktrees/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { now, pidAlive } from '../util/core.js';
import { readJson, atomicWrite, ensureDir, logError } from '../util/fsx.js';
import { listJobs, nextJob, update } from './queue.js';
import { kerbInvocation } from '../init/install.js';

export const IDLE_MS = 60_000;
export const NICE = 10;

export function lockPath(root) { return path.join(root, '.kerb', 'worker.lock'); }

/** The live worker's pid for this repo, or null. */
export function workerPid(root) {
  try {
    const pid = Number(fs.readFileSync(lockPath(root), 'utf8').split(' ')[0]);
    return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null;
  } catch { return null; }
}

function acquire(root) {
  ensureDir(path.join(root, '.kerb'));
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(lockPath(root), 'wx', 0o600);
      fs.writeSync(fd, `${process.pid} ${Date.now()}`);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let held = null;
      try { held = fs.readFileSync(lockPath(root), 'utf8'); } catch { continue; }
      if (workerPid(root)) return false;
      // Break the dead worker's lock only if it is still the one we read (another process may
      // have broken it and taken a fresh one meanwhile).
      const aside = `${lockPath(root)}.${process.pid}`;
      try {
        fs.renameSync(lockPath(root), aside);
        if (fs.readFileSync(aside, 'utf8') !== held) { try { fs.linkSync(aside, lockPath(root)); } catch { /* newer lock wins */ } }
        fs.unlinkSync(aside);
      } catch { /* raced */ }
    }
  }
  return false;
}

function release(root) {
  try {
    const [pid] = fs.readFileSync(lockPath(root), 'utf8').split(' ');
    if (Number(pid) === process.pid) fs.unlinkSync(lockPath(root));
  } catch { /* gone */ }
}

/**
 * Is the worker allowed? Config `worker`: on, off, manual (jobs queue, but only `kerb worker` run
 * by hand processes them), or auto (the default: on, except when CI=true).
 * @param {{ values: any }} config
 */
export function workerEnabled(config, env = process.env) {
  const v = config.values.worker || 'auto';
  if (v === 'off') return false;
  if (v === 'on' || v === 'manual') return true;
  return env.CI !== 'true' && env.CI !== '1';
}

// Per-hour budget, counted as the wall time of probe processes (an upper bound on their CPU
// time for single-process runners).
function budgetFile(root) { return path.join(root, '.kerb', 'worker-budget.json'); }
export function budgetLeftMs(root, config, nowTs = now()) {
  const cap = (Number(config.values.worker_budget_cpu_min_per_hour) || 15) * 60_000;
  const b = readJson(budgetFile(root), null);
  if (!b || nowTs - b.window_start >= 3_600_000) return cap;
  return Math.max(0, cap - (b.used_ms || 0));
}
export function chargeBudget(root, ms, nowTs = now()) {
  const b = readJson(budgetFile(root), null);
  const fresh = !b || nowTs - b.window_start >= 3_600_000;
  atomicWrite(budgetFile(root), JSON.stringify(fresh ? { window_start: nowTs, used_ms: ms } : { ...b, used_ms: (b.used_ms || 0) + ms }));
}

/** Start the worker in the background unless one is running or the worker is off. */
export function ensureWorker(root, config, env = process.env, argv = null) {
  if (!workerEnabled(config, env) || config.values.worker === 'manual' || workerPid(root)) return null;
  if (!nextJob(root)) return null;
  const inv = argv || workerArgv();
  try {
    const child = spawn(inv[0], [...inv.slice(1), 'worker'], { cwd: root, env, detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid;
  } catch (e) {
    logError('worker spawn', e);
    return null;
  }
}

/** How to run this Kerb (the standalone binary, or Node plus the entry script), as hooks do. */
export function workerArgv() {
  const inv = kerbInvocation();
  return inv.binary ? [inv.binary] : [inv.node, inv.script];
}

/**
 * The worker loop.
 * @param {{ root: string, config: any, env: NodeJS.ProcessEnv, idleMs?: number, once?: boolean,
 *   log?: (s: string) => void }} o once: run what is queued, then exit
 * @returns {Promise<{ ran: number, reason: string }>}
 */
export async function runWorker(o) {
  if (!acquire(o.root)) return { ran: 0, reason: 'another worker is running' };
  try { os.setPriority(0, NICE); } catch { /* not permitted here: run anyway */ }
  let current = null;
  let stopping = false;
  const onSignal = () => { stopping = true; if (current && current.abort) current.abort(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const { runJob } = await import('./jobs.js');
  let ran = 0;
  let reason = 'idle';
  try {
    // Crash recovery: a job left running by a dead worker failed.
    for (const j of listJobs(o.root)) if (j.state === 'running') update(o.root, j, { state: 'failed', error: 'the worker stopped during this job' });
    let idleSince = Date.now();
    for (;;) {
      if (stopping) { reason = 'stopped'; break; }
      const job = nextJob(o.root);
      if (!job) {
        if (o.once || Date.now() - idleSince >= (o.idleMs ?? IDLE_MS)) break;
        await new Promise((r) => setTimeout(r, Math.min(500, o.idleMs ?? IDLE_MS)));
        continue;
      }
      if (budgetLeftMs(o.root, o.config) <= 0) { reason = 'hourly budget used'; break; }
      const running = update(o.root, job, { state: 'running', started: now() });
      current = { abort: null };
      const t0 = Date.now();
      try {
        const result = await runJob({ ...o, job: running, control: current, stopping: () => stopping });
        update(o.root, running, stopping ? { state: 'cancelled', result } : { state: 'done', result, finished: now() });
      } catch (e) {
        logError(`worker job ${job.kind}`, e);
        update(o.root, running, { state: stopping ? 'cancelled' : 'failed', error: String(e && e.message ? e.message : e) });
      } finally {
        chargeBudget(o.root, Math.max(0, (current && current.probeMs) || 0));
        current = null;
      }
      ran++;
      idleSince = Date.now();
      if (o.log) o.log(`job ${job.id} (${job.kind}) finished in ${Date.now() - t0} ms`);
    }
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    release(o.root);
  }
  return { ran, reason };
}
