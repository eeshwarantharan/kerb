// kerb gc [--dry-run]: apply retention to kept states (KERB-V2 4.2). Deletes only Kerb's own
// refs, state files, blobs and stale worktrees, so it is not human-only.
import { findRoot } from '../util/repo.js';
import { now } from '../util/core.js';
import { Store } from '../store/jsonl.js';
import { gcStates } from '../state/gc.js';
import { parseOpts } from './args.js';

export default async function gc(ctx, args) {
  const { opts } = parseOpts(args, { 'dry-run': 'bool' });
  const { root, git } = findRoot(ctx.cwd);
  const recs = new Store(root).read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const r = gcStates(root, recs, now(), { dryRun: !!opts['dry-run'], git });
  if (ctx.json) { ctx.emitJson({ dry_run: !!opts['dry-run'], ...r }); return 0; }
  ctx.out(`kerb gc${opts['dry-run'] ? ' --dry-run' : ''} · ${r.kept} state${r.kept === 1 ? '' : 's'} kept, ${r.removed.length} ${opts['dry-run'] ? 'would be ' : ''}removed`);
  ctx.out(r.blobs_removed || r.worktrees_removed ? ` (${r.blobs_removed} blobs, ${r.worktrees_removed} worktrees)\n` : '\n');
  return 0;
}
