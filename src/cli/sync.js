// kerb sync [--push]: share proven fixes through git notes (KERB-V2 7.7). `kerb sync` fetches
// refs/notes/kerb from origin and merges the fixes in them; `--push` (human-only) pushes local
// notes. Notes hold only fingerprints, families, test ids and the Kerb version, on commits that
// already carry the code; uncommitted work is never shared.
import { findRoot } from '../util/repo.js';
import { now, UsageError } from '../util/core.js';
import { Store } from '../store/jsonl.js';
import { loadConfig } from '../config.js';
import { requireHuman } from '../bound/human.js';
import { git } from '../state/snapshot.js';
import { attachCommits, writeNotes, notesFixes, latestFixes, NOTES_REF } from '../insight/fixes.js';
import { parseOpts } from './args.js';

const REMOTE_REF = 'refs/notes/kerb-remote';

export default async function sync(ctx, args) {
  const { opts } = parseOpts(args, { push: 'bool', remote: 'string' });
  const { root, git: isGit } = findRoot(ctx.cwd);
  if (!isGit) throw new UsageError('kerb sync needs a git repository');
  const remote = opts.remote || 'origin';
  const config = loadConfig();
  const store = new Store(root);
  let recs = store.read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const attached = attachCommits(root, recs);
  if (attached.length) { store.append(attached); recs = store.read({ maxBytes: Number.MAX_SAFE_INTEGER }); }
  let wrote = 0;
  if (config.values.share_fixes === true) wrote = writeNotes(root, latestFixes(recs).filter((f) => f.commit && !f.shared));
  if (opts.push) {
    if (config.values.share_fixes !== true) throw new UsageError('sharing is off; a person can turn it on with kerb config set share_fixes true');
    requireHuman('kerb sync --push');
    const r = git(root, ['push', remote, `${NOTES_REF}:${NOTES_REF}`], { encoding: 'utf8' });
    if (r.status !== 0) throw new UsageError(`git push failed: ${r.stderr.trim()}`);
    if (ctx.json) ctx.emitJson({ pushed: true, notes_written: wrote, commits_attached: attached.length });
    else ctx.out(`kerb sync · pushed ${NOTES_REF} to ${remote}\n`);
    return 0;
  }
  const f = git(root, ['fetch', '--quiet', remote, `+${NOTES_REF}:${REMOTE_REF}`], { encoding: 'utf8' });
  const fetched = f.status === 0;
  const merged = fetched ? notesFixes(root, REMOTE_REF, latestFixes(recs)) : [];
  if (merged.length) store.append(merged.map((m) => ({ ...m, ts: now() })));
  if (ctx.json) { ctx.emitJson({ fetched, merged: merged.length, notes_written: wrote, commits_attached: attached.length, error: fetched ? null : f.stderr.trim() || null }); return 0; }
  ctx.out(`kerb sync · ${fetched ? `merged ${merged.length} shared fix${merged.length === 1 ? '' : 'es'} from ${remote}` : `no shared fixes on ${remote} yet`}${attached.length ? ` · ${attached.length} fix${attached.length === 1 ? '' : 'es'} matched to commits` : ''}${wrote ? ` · ${wrote} note${wrote === 1 ? '' : 's'} written` : ''}\n`);
  return 0;
}
