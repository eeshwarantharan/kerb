// kerb show fix:<id> | f:<id>: a proven fix (its tests, states, files, hunks and commit) or a
// cause finding, with the diff to read. Text only; nothing is applied (KERB-V2 7.6, 8.2).
import { findRoot } from '../util/repo.js';
import { UsageError } from '../util/core.js';
import { Store } from '../store/jsonl.js';
import { readState } from '../state/keep.js';
import { git } from '../state/snapshot.js';
import { scopeSpecs, treeHunks } from '../state/hunks.js';
import { latestFix } from '../insight/fixes.js';
import { findingLines } from '../insight/triggers.js';
import { parseOpts } from './args.js';

const MAX_DIFF_LINES = 200;

export default async function show(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const [ref] = positionals;
  const m = /^(fix|f|finding):(.+)$/.exec(ref || '');
  if (!m) throw new UsageError('usage: kerb show fix:<id> | f:<id>');
  const { root } = findRoot(ctx.cwd);
  const recs = new Store(root).read({ maxBytes: Number.MAX_SAFE_INTEGER });
  if (m[1] === 'fix') {
    const f = latestFix(recs, m[2]);
    if (!f) throw new UsageError(`no fix ${m[2]} (see kerb query fixes)`);
    let diff = '';
    const from = f.from_state && readState(root, f.from_state);
    const to = f.to_state && readState(root, f.to_state);
    if (from && to && from.tree && to.tree) {
      if (f.hunks && f.hunks.length) {
        const all = treeHunks(root, from.tree, to.tree, scopeSpecs(to));
        const want = new Set(f.hunks.map((h) => h.id));
        diff = all ? all.files.flatMap((x) => x.hunks.filter((h) => want.has(h.id)).flatMap((h) => [`--- ${x.file}`, h.header, ...h.lines])).join('\n') : '';
      } else {
        const r = git(root, ['diff', '--no-color', from.tree, to.tree, ...scopeSpecs(to)], { encoding: 'utf8' });
        diff = r.status === 0 ? r.stdout : '';
      }
    }
    if (ctx.json) { ctx.emitJson({ fix: f, diff }); return 0; }
    ctx.out(`kerb show fix:${f.id.slice(0, 6)} · ${f.shared ? 'shared by a teammate' : `fixed ${new Date(f.ts).toISOString().slice(0, 16).replace('T', ' ')}`} · ${f.confidence}\n`);
    if (f.test_ids && f.test_ids.length) ctx.out(`  tests     ${f.test_ids.slice(0, 5).join(', ')}${f.test_ids.length > 5 ? ', …' : ''}\n`);
    if (f.first_fail_line) ctx.out(`  failure   ${f.first_fail_line}\n`);
    if (f.from_state) ctx.out(`  states    ${f.from_state} → ${f.to_state}\n`);
    if (f.hunks) ctx.out(`  hunks     ${f.hunks.map((h) => h.location).join(', ')}${f.hunk_count ? ` (of ${f.hunk_count})` : ''}\n`);
    else if (f.files && f.files.length) ctx.out(`  files     ${f.files.join(', ')}${f.stats ? ` (+${f.stats.insertions} -${f.stats.deletions})` : ''}\n`);
    if (f.commit) ctx.out(`  commit    ${f.commit}\n`);
    if (diff) {
      const lines = diff.split('\n');
      ctx.out(`\n${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n${lines.length > MAX_DIFF_LINES ? `… ${lines.length - MAX_DIFF_LINES} more lines\n` : ''}`);
    } else if (f.commit) ctx.out(`  see it: git show ${f.commit.slice(0, 12)}\n`);
    return 0;
  }
  const f = recs.filter((r) => r.type === 'finding').reverse().find((r) => r.id === m[2] || r.id.startsWith(m[2]));
  if (!f) throw new UsageError(`no finding ${m[2]}`);
  if (ctx.json) { ctx.emitJson({ finding: f }); return 0; }
  ctx.out(`${findingLines(f).join('\n')}\n`);
  ctx.out(`  states    good ${f.good_state} → bad ${f.bad_state}${f.narrowed ? `\n  probe     ${f.narrowed}` : ''}\n`);
  return 0;
}
