// The worker's job queue (KERB-V2 8.1): one JSON file per job in .kerb/jobs/, with a schema
// version so jobs survive a Kerb upgrade. States: queued, running, done, failed, cancelled.
//
// A job runs a command, and .kerb/ sits inside the repo, where a cloned repo could have planted
// one. So each job is signed with a per-user secret (~/.kerb/secret) when it is queued, and only
// jobs with a valid signature ever run: a planted job is listed, never run.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { newId, now } from '../util/core.js';
import { atomicWrite, ensureDir, homeKerbDir } from '../util/fsx.js';

export const JOB_SCHEMA = 1;
export const KINDS = new Set(['cause', 'minimize']);

function secret() {
  const file = path.join(homeKerbDir(), 'secret');
  try {
    const s = fs.readFileSync(file);
    if (s.length >= 32) return s;
  } catch { /* first use */ }
  try { fs.writeFileSync(file, crypto.randomBytes(32), { mode: 0o600, flag: 'wx' }); } catch { /* another process made it */ }
  return fs.readFileSync(file);
}

/** The signature of a job's fixed fields (what it runs can't change after it was queued). */
export function signJob(job) {
  return crypto.createHmac('sha256', secret()).update(JSON.stringify([job.id, job.kind, job.created, job.payload])).digest('hex');
}

/** Was this job queued by this user's Kerb? */
export function trusted(job) {
  if (!job || typeof job.sig !== 'string' || !/^[0-9a-f]{64}$/.test(job.sig)) return false;
  try { return crypto.timingSafeEqual(Buffer.from(job.sig, 'hex'), Buffer.from(signJob(job), 'hex')); } catch { return false; }
}

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
  const job = { schema: JOB_SCHEMA, id: newId(ts), kind, state: 'queued', created: ts, updated: ts, dedupe, payload, result: null, error: null };
  return writeJob(root, { ...job, sig: signJob(job) });
}

export function update(root, job, patch) {
  return writeJob(root, { ...job, ...patch, updated: now() });
}

/**
 * The next job to run: cause jobs first; fix minimisation only when nothing else waits (8.2).
 * Unsigned jobs (not queued by this user's Kerb) never run.
 */
export function nextJob(root) {
  const runnable = listJobs(root).filter((j) => j.state === 'queued' && (j.schema || 0) <= JOB_SCHEMA && KINDS.has(j.kind) && trusted(j));
  return runnable.find((j) => j.kind !== 'minimize') || runnable[0] || null;
}
