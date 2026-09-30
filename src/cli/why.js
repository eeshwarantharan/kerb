// kerb why [run-id]: explain a refusal (default: the latest) with its evidence.
import { findRoot } from '../util/repo.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { formatDuration, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';

const EXPLAIN = {
  identical_retry: 'Your files (in this command\'s scope) and environment were identical to the end state of a run that failed, and no setup command ran since, so running it again could not change the result.',
  deja_vu: 'Your files matched the state of an earlier attempt that already failed, even though you had changed them in between.',
  breaker_open: 'The same failure happened several times in a row despite edits, so the approach itself likely needs rethinking.',
  policy_blocked: 'The command would touch something this environment blocks, so it would fail (or be denied) if it ran.',
  human_only: 'The command would switch off or change Kerb, which only the user may do.',
};

export default async function why(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const recs = new Store(root).read();
  const refusals = recs.filter((r) => r.type === 'refusal');
  const want = positionals[0];
  let ref;
  if (want) {
    ref = refusals.find((r) => r.id === want || r.id.startsWith(want) || r.matched_run === want);
    if (!ref) throw new UsageError(`no refusal ${want} in this repo (see kerb history)`);
  } else {
    ref = refusals[refusals.length - 1];
    if (!ref) {
      if (ctx.json) ctx.emitJson({ refusal: null });
      else ctx.out('kerb why · no refusals recorded in this repo\n');
      return 0;
    }
  }
  const runs = buildRuns(recs);
  const matched = ref.matched_run ? runs.find((r) => r.id === ref.matched_run) : null;
  if (ctx.json) {
    ctx.emitJson({ refusal: ref, matched_run: matched || null, explanation: EXPLAIN[ref.reason] || null });
    return 0;
  }
  ctx.out(`kerb why · ${ref.reason} at ${new Date(ref.ts).toISOString().replace('T', ' ').slice(0, 19)} (refusal ${ref.id})\n`);
  ctx.out(`  command   ${ref.cmd}\n  key       ${ref.key}\n  summary   ${ref.summary}\n`);
  if (ref.evidence) ctx.out(`  evidence  ${ref.evidence}\n`);
  if (matched) {
    ctx.out(`  matched run ${matched.id}: exit ${matched.exit ?? '?'}, ${matched.failure_kind || matched.class_result || 'result unknown'} failure, ${formatDuration(matched.duration_ms)}, ${matched.shown_bytes ?? 0} bytes of output\n`);
    if (matched.first_fail_line) ctx.out(`    first failing line: ${matched.first_fail_line}\n`);
    if (matched.log) ctx.out(`    log: ${matched.log}\n`);
  }
  if (ref.boundary) ctx.out(`  boundary  ${ref.boundary}\n`);
  if (EXPLAIN[ref.reason]) ctx.out(`  why       ${EXPLAIN[ref.reason]}\n`);
  if (ref.next) ctx.out(`  next      ${ref.next}\n`);
  return 0;
}
