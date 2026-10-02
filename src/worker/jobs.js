// Job dispatch for the worker.
import { isolate, minimize } from './cause.js';

export async function runJob(o) {
  if (o.job.kind === 'cause') return isolate(o);
  if (o.job.kind === 'minimize') return minimize(o);
  throw new Error(`unknown job kind ${o.job.kind}`);
}
