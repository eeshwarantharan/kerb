// The worker's job queue (KERB-V2 8.1): one JSON file per job in .kerb/jobs/, with a schema
// version so jobs survive a Kerb upgrade. States: queued, running, done, failed, cancelled.
import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from '../util/core.js';
import { atomicWrite, ensureDir } from '../util/fsx.js';

export const JOB_SCHEMA = 1;
export const KINDS = new Set(['cause', 'minimize']);

export function jobsDir(root) {
  return path.join(root, '.kerb', 'jobs');
}

export function writeJob(root, job) {
  ensureDir(jobsDir(root));
  atomicWrite(path.join(jobsDir(root), `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`);
  return job;
}

export function readJob(root, id) {
  try { return JSON.parse(fs.readFileSync(path.join(jobsDir(root), `${id}.json`), 'utf8')); } catch { return null; }
}

/** All jobs, oldest first. Jobs from a newer Kerb (schema above ours) are listed but never run. */
export function listJobs(root) {
  let names = [];
  try { names = fs.readdirSync(jobsDir(root)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(jobsDir(root), n), 'utf8'))); } catch { /* torn: skipped */ }
  }
  return out.sort((a, b) => (a.created - b.created) || (a.id < b.id ? -1 : 1));
}

/**
 * Queue a job unless an equal one (same kind and dedupe key) is queued or running.
 * @returns {any | null} the job, or null when a duplicate exists
 */
export function enqueue(root, kind, payload, { dedupe = null } = {}) {
  if (dedupe && listJobs(root).some((j) => j.kind === kind && j.dedupe === dedupe && (j.state === 'queued' || j.state === 'running'))) return null;
  const ts = now();
  return writeJob(root, { schema: JOB_SCHEMA, id: newId(ts), kind, state: 'queued', created: ts, updated: ts, dedupe, payload, result: null, error: null });
}

export function update(root, job, patch) {
  return writeJob(root, { ...job, ...patch, updated: now() });
}

/** The next job to run: cause jobs first; fix minimisation only when nothing else waits (8.2). */
export function nextJob(root) {
  const runnable = listJobs(root).filter((j) => j.state === 'queued' && (j.schema || 0) <= JOB_SCHEMA && KINDS.has(j.kind));
  return runnable.find((j) => j.kind !== 'minimize') || runnable[0] || null;
}
