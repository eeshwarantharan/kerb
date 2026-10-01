// Run and test history for the insight engines (KERB-V2 7), read from the event log.
import { buildRuns } from '../store/jsonl.js';
import { isFailure, isSuccess } from '../loop/outcome.js';

const endTs = (r) => r.end_ts ?? r.ts;

/** Finished check runs of a key, oldest first. */
export function keyRuns(recs, key) {
  return buildRuns(recs).filter((r) => r.finished && r.key === key && r.class === 'check' && r.exit != null).sort((a, b) => endTs(a) - endTs(b));
}

/** Runs since (not including) the last success before the latest run, plus the latest. */
export function sinceSuccess(runs) {
  let i = runs.length - 2;
  while (i >= 0 && !isSuccess(runs[i])) i--;
  return runs.slice(i + 1);
}

/** run id → [test_result] */
export function testsByRun(recs) {
  const m = new Map();
  for (const r of recs) {
    if (r.type !== 'test_result') continue;
    if (!m.has(r.run)) m.set(r.run, []);
    m.get(r.run).push(r);
  }
  return m;
}

/** Tests that both passed and failed on the same state (7.1): test id set. */
export function flakyTests(recs) {
  const seen = new Map(); // test_id\0state → Set(status)
  const flaky = new Set();
  for (const r of recs) {
    if (r.type !== 'test_result' || !r.state) continue;
    const k = `${r.test_id}\0${r.state}`;
    const s = seen.get(k) || new Set();
    s.add(r.status === 'error' ? 'fail' : r.status);
    seen.set(k, s);
    if (s.has('pass') && s.has('fail')) flaky.add(r.test_id);
  }
  return flaky;
}

/** Failing count of a run: from its test summary, else 0 for a pass and null when unknown. */
export function failingCount(r) {
  if (r.tests_summary && Number.isInteger(r.tests_summary.failed)) return r.tests_summary.failed + (r.tests_summary.errors || 0);
  return isSuccess(r) ? 0 : null;
}

export { isFailure, isSuccess, endTs };

/** The display name of a test id: its name, without framework and file. */
export function testName(id) {
  const i = id.indexOf('::');
  return i === -1 ? id : id.slice(i + 2);
}

/** A command for display: the part of a key after `cwd::`. */
export function keyCommand(key) {
  const i = key.indexOf('::');
  return i === -1 ? key : key.slice(i + 2);
}

/**
 * A failing run's identity for the breaker and stall rules: its failing tests, flaky ones left
 * out (7.1), when test results exist; else its output fingerprint. '' when every failing test
 * is flaky (such a run doesn't count).
 */
export function failPrinter(recs) {
  const byRun = testsByRun(recs);
  const flaky = flakyTests(recs);
  return (r) => {
    const tests = byRun.get(r.id);
    if (!tests || !tests.length) return r.fingerprint || null;
    const failing = tests.filter((t) => (t.status === 'fail' || t.status === 'error')).map((t) => t.test_id);
    if (!failing.length) return r.fingerprint || null;
    const real = failing.filter((id) => !flaky.has(id)).sort();
    return real.length ? `t:${real.join('\n')}` : '';
  };
}
