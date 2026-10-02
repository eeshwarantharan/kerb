// pytest (KERB-V2 5.4): `-v` lines, the `-rA` short summary, the default summary (failures and
// errors only) and the FAILURES section for locations. JUnit XML (`--junitxml`) goes through
// junit.js. Recorded with pytest 9.
//   -v:       "tests/test_cart.py::test_discount FAILED      [ 28%]"
//   summary:  "FAILED tests/test_cart.py::test_discount - assert 100 == 90", "ERROR tests/…::test_error"
//   sections: "____ TestUser.test_logout ____" … "tests/test_cart.py:22: AssertionError"
//   totals:   "=== 3 failed, 2 passed, 1 skipped, 1 error in 0.02s ===" (`-q`: the same line without ===)
import { lines, repoPath, summarize } from './common.js';

export const framework = 'pytest';
/** The `-q` totals line on its own: counts only, then the time. */
const QUIET_LINE = /^((?:\d+ (?:failed|passed|skipped|deselected|xfailed|xpassed|warnings?|errors?)(?:, )?)+) in [\d.]+s(?: \([^)]*\))?$/;
const QUIET_TOTALS = new RegExp(`(^|\\n)${QUIET_LINE.source.slice(1, -1)}\\s*$`);
const MAP = { PASSED: 'pass', FAILED: 'fail', ERROR: 'error', SKIPPED: 'skip', XFAIL: 'skip', XPASS: 'pass' };

/** "tests/test_cart.py::TestUser::test_logout" → file and "TestUser > test_logout". */
export function splitNodeId(id, ctx) {
  const parts = id.split('::');
  return { file: repoPath(parts[0], ctx), name: parts.slice(1).join(' > ') };
}

export function parse(text, ctx) {
  // `-q` drops the session header and the === around the totals: "2 failed, 2 passed in 0.02s".
  if (!/(^|\n)=+ test session starts =+/.test(text) && !/(^|\n)=+ .*(passed|failed|error).* in [\d.]+s/.test(text) && !QUIET_TOTALS.test(text)) return null;
  const tests = new Map();
  const put = (id, patch) => {
    const { file, name } = splitNodeId(id, ctx);
    if (!name) return;
    const k = `${file}::${name}`;
    tests.set(k, { file, name, status: 'pass', location: null, message: null, duration_ms: null, ...(tests.get(k) || {}), ...patch });
  };
  let section = null; // the test whose FAILURES/ERRORS section we are in
  let counts = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(\S+?::\S.*?) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)\b/.exec(line))) { put(m[1], { status: MAP[m[2]] }); continue; }
    if ((m = /^(PASSED|FAILED|ERROR|XFAIL|XPASS) (\S+?::\S+?)(?: - (.*))?$/.exec(line))) {
      const { file, name } = splitNodeId(m[2], ctx);
      const prev = tests.get(`${file}::${name}`);
      put(m[2], { status: MAP[m[1]], ...(m[3] && !(prev && prev.message) ? { message: m[3] } : {}) });
      continue;
    }
    if ((m = /^_{3,} (?:ERROR at \w+ of )?(.+?) _{3,}$/.exec(line))) { section = { name: m[1].replace(/\./g, ' > '), message: null }; continue; }
    if (section && !section.message && (m = /^E\s+(.+)$/.exec(line))) { section.message = m[1]; continue; }
    if (section && (m = /^(\S+\.py):(\d+): \w/.exec(line))) {
      const file = repoPath(m[1], ctx);
      const k = `${file}::${section.name}`;
      const t = tests.get(k) || { file, name: section.name, status: 'fail', location: null, message: null, duration_ms: null };
      t.location = `${file}:${m[2]}`;
      if (section.message) t.message = section.message;
      tests.set(k, t);
      section = null;
      continue;
    }
    if ((m = /^=+ (.*\b(?:passed|failed|error|errors|skipped|no tests ran)\b.*) in [\d.]+s(?: \([^)]*\))? =+$/.exec(line)) || (m = QUIET_LINE.exec(line))) {
      const part = (w) => { const x = new RegExp(`(\\d+) ${w}`).exec(m[1]); return x ? Number(x[1]) : 0; };
      counts = { failed: part('failed'), passed: part('passed') + part('xpassed'), skipped: part('skipped') + part('xfailed') + part('deselected') * 0, errors: part('errors?') };
    }
  }
  const results = [...tests.values()];
  if (!results.length && !counts) return null;
  return { framework, results, summary: summarize(results, counts) };
}
