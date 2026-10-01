// Delta (KERB-V2 7.1): after a check run with test results, what changed since the previous run
// of the same key. Monochrome, at most 8 lines, then a "more" line.
//   kerb: npm test · 2 failing (was 5)
//         + fixed: applies discount; rounds totals
//         ! still failing: session timeout · cart.test.js:42 expected 90, got 100
//         - new failure: logout clears session · user.test.js:2 …
//         ~ flaky: checkout retries (passed and failed on the same files)
import { keyRuns, testsByRun, flakyTests, failingCount, testName, keyCommand } from './history.js';

export const MAX_LINES = 8;
const FAILING = new Set(['fail', 'error']);

const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const detail = (t) => [t.location, t.message].filter(Boolean).join(' ');

/**
 * @param {any[]} recs the event log (including the run just recorded)
 * @param {string} runId the run just recorded
 * @returns {{ lines: string[], fixed: string[], still: string[], added: string[], flaky: string[] } | null}
 */
export function computeDelta(recs, runId) {
  const all = recs.filter((r) => r.type === 'start' || r.type === 'end');
  const cur = all.find((r) => r.type === 'end' && r.id === runId);
  if (!cur || !cur.framework || cur.framework === 'unknown') return null;
  const runs = keyRuns(recs, cur.key);
  const i = runs.findIndex((r) => r.id === runId);
  if (i === -1) return null;
  const run = runs[i];
  const prev = [...runs.slice(0, i)].reverse().find((r) => r.framework && r.framework !== 'unknown') || null;
  const byRun = testsByRun(recs);
  const curTests = byRun.get(runId) || [];
  const flaky = flakyTests(recs);
  const curFail = curTests.filter((t) => FAILING.has(t.status));
  const failing = failingCount(run) ?? curFail.length;
  const cmd = keyCommand(run.key);
  const out = { lines: [], fixed: [], still: [], added: [], flaky: [] };
  if (!prev) {
    // First run of the key: a summary, with the first three failures.
    if (!failing) return null;
    const total = run.tests_summary && run.tests_summary.total;
    out.lines.push(`kerb: ${cmd} · ${failing} failing${total ? ` of ${total}` : ''}`);
    for (const t of curFail.slice(0, 3)) out.lines.push(`      ! ${short(`${testName(t.test_id)}${detail(t) ? ` · ${detail(t)}` : ''}`)}`);
    if (curFail.length > 3) out.lines.push(`      … and ${curFail.length - 3} more (kerb why ${runId})`);
    return out;
  }
  const prevTests = byRun.get(prev.id) || [];
  const prevFail = new Map(prevTests.filter((t) => FAILING.has(t.status)).map((t) => [t.test_id, t]));
  const curById = new Map(curTests.map((t) => [t.test_id, t]));
  const curFailIds = new Set(curFail.map((t) => t.test_id));
  // When the test set shrank (a crash, a narrower run), only explicit passes count as fixed.
  const shrank = prev.tests_summary && run.tests_summary && run.tests_summary.total < prev.tests_summary.total;
  for (const [id] of prevFail) {
    if (curFailIds.has(id)) out.still.push(id);
    else {
      const now = curById.get(id);
      if (now && now.status === 'pass') out.fixed.push(id);
      else if (!now && !shrank) out.fixed.push(id);
    }
  }
  for (const t of curFail) if (!prevFail.has(t.test_id)) out.added.push(t.test_id);
  out.flaky = [...new Set([...out.fixed, ...out.still, ...out.added])].filter((id) => flaky.has(id));
  const was = failingCount(prev) ?? prevFail.size;
  if (!out.fixed.length && !out.added.length && !out.flaky.length && failing === was) {
    if (!failing) return null; // green, as before: nothing to say
  }
  const head = failing ? `${failing} failing (was ${was})` : `all passing (was ${was} failing)`;
  out.lines.push(`kerb: ${cmd} · ${head}`);
  const body = [];
  const names = (ids) => ids.map(testName).join('; ');
  const notFlaky = (ids) => ids.filter((id) => !out.flaky.includes(id));
  if (notFlaky(out.fixed).length) body.push(`      + fixed: ${short(names(notFlaky(out.fixed)))}`);
  for (const id of notFlaky(out.still)) { const t = curById.get(id); body.push(`      ! still failing: ${short(`${testName(id)}${t && detail(t) ? ` · ${detail(t)}` : ''}`)}`); }
  for (const id of notFlaky(out.added)) { const t = curById.get(id); body.push(`      - new failure: ${short(`${testName(id)}${t && detail(t) ? ` · ${detail(t)}` : ''}`)}`); }
  if (out.flaky.length) body.push(`      ~ flaky: ${short(names(out.flaky))} (passed and failed on the same files)`);
  if (body.length > MAX_LINES - 1) {
    const more = body.length - (MAX_LINES - 2);
    out.lines.push(...body.slice(0, MAX_LINES - 2), `      … and ${more} more (kerb why ${runId})`);
  } else out.lines.push(...body);
  return out;
}
