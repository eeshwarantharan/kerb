// kerb jobs [--json]: the worker's queue (KERB-V2 8.1).
import { findRoot } from '../util/repo.js';
import { listJobs, trusted } from '../worker/queue.js';
import { parseOpts } from './args.js';

export default async function jobs(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const all = listJobs(root);
  if (ctx.json) { ctx.emitJson({ jobs: all }); return 0; }
  if (!all.length) { ctx.out('kerb jobs · none\n'); return 0; }
  for (const j of all.slice(-30)) {
    const what = j.kind === 'cause' ? j.payload?.test_id : j.kind === 'minimize' ? `fix ${j.payload?.fix_id}` : '';
    const res = j.result ? ` · ${j.result.confidence || ''}${j.result.reason ? ` (${j.result.reason})` : ''}${j.result.hunks != null ? `${j.result.hunks} hunk(s)` : ''}`.trimEnd() : j.error ? ` · ${j.error}` : '';
    const untrusted = j.state === 'queued' && !trusted(j) ? ' · untrusted: not queued by Kerb for this user, so it never runs' : '';
    ctx.out(`${new Date(j.created).toISOString().slice(0, 16).replace('T', ' ')}  ${j.state.padEnd(9)} ${j.kind.padEnd(8)} ${what}${res}${untrusted}\n`);
  }
  return 0;
}
