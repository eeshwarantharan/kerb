// kerb restore <state> --patch | --keep-except <finding> | --in-place (KERB-V2 7.5).
//   --patch                 write a patch that turns the current files (in the state's scope) into
//                           the state; changes nothing by itself, so agents may use it
//   --keep-except <finding> a patch that reverts only a cause finding's culprit hunks
//   --in-place              human-only: back up the current changes with git stash, then apply
import fs from 'node:fs';
import path from 'node:path';
import { UsageError, KerbError, EXIT, now } from '../util/core.js';
import { prepare } from '../engine.js';
import { requireHuman } from '../bound/human.js';
import { readState, treeOf } from '../state/keep.js';
import { git } from '../state/snapshot.js';
import { scopeSpecs, treeHunks, patchFromHunks } from '../state/hunks.js';
import { currentState } from '../insight/verify.js';
import { buildRuns } from '../store/jsonl.js';
import { parseOpts } from './args.js';

/** A state from an id, a unique id prefix, or a run id (its post-state). */
export function resolveState(root, recs, want) {
  if (!want) return null;
  const dir = path.join(root, '.kerb', 'states');
  let ids = [];
  try { ids = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { /* none */ }
  const exact = ids.find((i) => i === want);
  if (exact) return readState(root, exact);
  const pre = ids.filter((i) => i.startsWith(want));
  if (pre.length === 1) return readState(root, pre[0]);
  if (pre.length > 1) throw new UsageError(`state ${want} is ambiguous`);
  const run = buildRuns(recs).find((r) => r.id === want || r.id.startsWith(want));
  return run && run.post_hash ? readState(root, run.post_hash) : null;
}

function refuse(reason) { throw new KerbError(EXIT.USAGE, `restore · ${reason}`); }

export default async function restore(ctx, args) {
  const { opts, positionals } = parseOpts(args, { patch: 'bool', 'keep-except': 'string', 'in-place': 'bool', out: 'string' });
  const [want] = positionals;
  if (!want) throw new UsageError('usage: kerb restore <state> --patch | --keep-except <finding> | --in-place');
  if (!opts.patch && !opts['keep-except'] && !opts['in-place']) throw new UsageError('choose --patch, --keep-except <finding> or --in-place');
  const prep = prepare(ctx, { command: 'true', reap: false });
  if (!prep.git) refuse('patches need a git repository; outside git, states are kept in .kerb/states and .kerb/blobs');
  const recs = prep.store.read({ maxBytes: Number.MAX_SAFE_INTEGER });
  const state = resolveState(prep.root, recs, want);
  if (!state) refuse(`no kept state ${want} (see kerb green, or kerb history)`);
  if (state.mode !== 'git') refuse('this state was kept outside git and has no patch form');
  if (!state.materializable) refuse(`${state.id} is not materializable: it has a file over 5 MB whose content was not kept`);

  // The current files, in the state's scope (the key whose run kept the state decides it).
  const run = buildRuns(recs).find((r) => r.finished && r.post_hash === state.id);
  const cur = currentState(prep.root, true, run ? run.key : '.::true', prep.policy, ctx.env);
  const curTree = cur.snapshot ? treeOf(prep.root, cur.snapshot) : null;
  if (!curTree) refuse('could not snapshot the current files');

  let patch;
  let what;
  if (opts['keep-except']) {
    const id = opts['keep-except'].replace(/^f:/, '');
    const finding = recs.find((r) => r.type === 'finding' && (r.id === id || r.id.startsWith(id)));
    if (!finding) refuse(`no finding ${opts['keep-except']} (see kerb query findings)`);
    const good = readState(prep.root, finding.good_state);
    const bad = readState(prep.root, finding.bad_state);
    if (!good || !bad) refuse('the finding\'s states are no longer kept');
    const diff = treeHunks(prep.root, good.tree, bad.tree, scopeSpecs(bad));
    const ids = new Set((finding.culprit_hunks || []).map((h) => (typeof h === 'string' ? h : h.id)));
    patch = patchFromHunks(prep.root, diff, ids, { reverse: true, fromTree: good.tree, toTree: bad.tree });
    what = `reverts ${ids.size} culprit hunk${ids.size === 1 ? '' : 's'} of finding ${finding.id}; your other edits are kept`;
  } else {
    const diff = treeHunks(prep.root, curTree, state.tree, scopeSpecs(state));
    if (!diff) refuse('git diff failed');
    patch = diff.text;
    what = `turns the current files into ${state.id}${state.scope && state.scope !== '.' ? ` (scope ${state.scope})` : ''}`;
  }
  const out = path.resolve(ctx.cwd, opts.out || path.join(prep.root, '.kerb', 'patches', `${state.id}-${now()}.patch`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, patch, { mode: 0o600 });
  const rel = path.relative(prep.root, out);

  if (!opts['in-place']) {
    if (ctx.json) { ctx.emitJson({ state: state.id, patch: rel, empty: !patch, applied: false }); return 0; }
    ctx.out(patch ? `kerb restore · wrote ${rel}: ${what}\n  apply it: git apply ${rel}\n` : `kerb restore · the current files already match ${state.id}\n`);
    return 0;
  }
  requireHuman(`kerb restore ${state.id} --in-place`);
  if (!patch) { ctx.out(`kerb restore · the current files already match ${state.id}\n`); return 0; }
  // Back up first: stash everything (tracked and untracked), then put it back, leaving the stash.
  const st = git(prep.root, ['status', '--porcelain'], { encoding: 'utf8' });
  let stashed = false;
  if (st.stdout.trim()) {
    const s = git(prep.root, ['stash', 'push', '--include-untracked', '-m', `kerb restore backup before ${state.id}`], { encoding: 'utf8' });
    if (s.status !== 0) refuse(`git stash failed: ${s.stderr.trim()}`);
    stashed = true;
    const a = git(prep.root, ['stash', 'apply', '--index'], { encoding: 'utf8' });
    if (a.status !== 0) git(prep.root, ['stash', 'apply'], { encoding: 'utf8' });
  }
  const ap = git(prep.root, ['apply', out], { encoding: 'utf8' });
  if (ap.status !== 0) refuse(`git apply failed (${ap.stderr.trim()}); nothing was changed${stashed ? '; your backup is in git stash list' : ''}`);
  if (ctx.json) { ctx.emitJson({ state: state.id, patch: rel, applied: true, stashed }); return 0; }
  ctx.out(`kerb restore · applied ${rel}: ${what}\n${stashed ? '  your previous changes are saved: git stash list (kerb restore backup …)\n' : ''}`);
  return 0;
}
