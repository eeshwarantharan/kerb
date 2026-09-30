// kerb diff <runA> <runB>: files that differ between two runs' snapshots, and whether fingerprints match.
import { UsageError } from '../util/core.js';
import { findRoot } from '../util/repo.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { parseOpts } from './args.js';
import { readSnapshot, diffSnapshots } from '../loop/workspace.js';

/** Find a run by id or unique id prefix. */
export function findRun(runs, id) {
  const exact = runs.find((r) => r.id === id);
  if (exact) return exact;
  const matches = runs.filter((r) => r.id.startsWith(id));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new UsageError(`run id ${id} is ambiguous`);
  throw new UsageError(`no run ${id} in this repo (see kerb history)`);
}

export default async function diff(ctx, args) {
  const { positionals } = parseOpts(args, {});
  if (positionals.length !== 2) throw new UsageError('usage: kerb diff <runA> <runB>');
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  const runs = buildRuns(store.read());
  const a = findRun(runs, positionals[0]);
  const b = findRun(runs, positionals[1]);
  const sa = readSnapshot(store, a.id);
  const sb = readSnapshot(store, b.id);
  const files = diffSnapshots(root, sa, sb);
  const sameFingerprint = a.fingerprint && b.fingerprint ? a.fingerprint === b.fingerprint : null;
  if (ctx.json) {
    ctx.emitJson({ a: a.id, b: b.id, files, comparable: files !== null, same_fingerprint: sameFingerprint, same_hash: a.post_hash === b.post_hash });
    return 0;
  }
  if (files === null) {
    ctx.out(`kerb diff · no comparable snapshots for ${a.id} and ${b.id} (snapshots exist only for check-class runs)\n`);
  } else if (!files.length) {
    ctx.out(`kerb diff · ${a.id} → ${b.id}: no file changes\n`);
  } else {
    ctx.out(`kerb diff · ${a.id} → ${b.id}: ${files.length} file${files.length === 1 ? '' : 's'} changed\n`);
    for (const f of files) ctx.out(`  ${f}\n`);
  }
  if (sameFingerprint !== null) ctx.out(`  output: ${sameFingerprint ? 'same failure fingerprint' : 'different output'}\n`);
  return 0;
}
