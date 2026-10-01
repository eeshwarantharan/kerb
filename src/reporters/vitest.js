// Vitest (KERB-V2 5.4): the default, verbose and agent/minimal reporters (text), and the JSON
// reporter file (same shape as Jest's, see jest.js). Recorded with Vitest 3.2.7 and 4.1.11.
//   default:  " ❯ src/cart.test.js (4 tests | 1 failed | 1 skipped) 9ms" then
//             "   × cart > applies discount 6ms" (tests listed for failing files)
//   agent:    the same file lines, failing tests by their own name only
//   verbose:  " ✓ src/cart.test.js > cart > adds items 1ms"
//   failures: " FAIL  src/cart.test.js > cart > applies discount", then the error, then
//             " ❯ src/cart.test.js:5:56"
//   summary:  "      Tests  2 failed | 3 passed | 1 skipped (6)"
import { lines, repoPath, summarize } from './common.js';

export const framework = 'vitest';
const SYM = { '✓': 'pass', '√': 'pass', '×': 'fail', '✗': 'fail', '↓': 'skip', '↩': 'skip' };
const FILE_LINE = /^ (?:❯|✓|×|↓) (\S+\.\w+) \((\d+) tests?(?: \|[^)]*)?\)/;
const TEST_LINE = /^(\s{3,})([✓√×✗↓↩]) (.+?)(?: (\d+(?:\.\d+)?)ms)?$/;
const VERBOSE_LINE = /^ ([✓√×✗↓↩]) (\S+\.\w+) > (.+?)(?: (\d+(?:\.\d+)?)ms)?$/;
const FAIL_HEAD = /^ FAIL {2}(\S+\.\w+) > (.+)$/;
const SUMMARY = /^\s+Tests\s{2}(.+)\((\d+)\)\s*$/;

export function parse(text, ctx) {
  if (!/(^|\n) RUN {2}v\d|(^|\n)\s+Test Files {2}/.test(text)) return null;
  const tests = new Map(); // file::name → result
  const put = (file, name, patch) => {
    const k = `${file}::${name}`;
    tests.set(k, { file, name, status: 'pass', location: null, message: null, duration_ms: null, ...(tests.get(k) || {}), ...patch });
  };
  const leaves = []; // agent reporter: failing tests listed by their own name
  let file = null;
  let lastKey = null;
  let failing = null;
  let counts = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = FILE_LINE.exec(line))) { file = repoPath(m[1], ctx); lastKey = null; continue; }
    if ((m = VERBOSE_LINE.exec(line))) {
      const f = repoPath(m[2], ctx);
      put(f, m[3], { status: SYM[m[1]], duration_ms: m[4] ? Number(m[4]) : null });
      lastKey = `${f}::${m[3]}`;
      continue;
    }
    if (file && (m = TEST_LINE.exec(line)) && !/^\s+→/.test(line)) {
      const name = m[3];
      if (name.includes(' > ') || m[1].length === 3) put(file, name, { status: SYM[m[2]], duration_ms: m[4] ? Number(m[4]) : null });
      else leaves.push({ file, name, status: SYM[m[2]], duration_ms: m[4] ? Number(m[4]) : null });
      lastKey = `${file}::${name}`;
      continue;
    }
    if ((m = /^\s+→ (.+)$/.exec(line)) && lastKey && tests.has(lastKey)) { tests.get(lastKey).message = tests.get(lastKey).message || m[1]; continue; }
    if ((m = FAIL_HEAD.exec(line))) {
      const f = repoPath(m[1], ctx);
      failing = { file: f, name: m[2], expectMessage: true };
      put(f, m[2], { status: 'fail' });
      continue;
    }
    if (failing) {
      const t = tests.get(`${failing.file}::${failing.name}`);
      if (failing.expectMessage && line.trim()) { t.message = t.message || line.trim(); failing.expectMessage = false; continue; }
      if ((m = /^ ❯ (\S+?):(\d+):\d+$/.exec(line))) { t.location = `${repoPath(m[1], ctx)}:${m[2]}`; failing = null; continue; }
    }
    if ((m = SUMMARY.exec(line))) {
      const part = (w) => { const x = new RegExp(`(\\d+) ${w}`).exec(m[1]); return x ? Number(x[1]) : 0; };
      counts = { failed: part('failed'), passed: part('passed'), skipped: part('skipped') + part('todo'), total: Number(m[2]) };
    }
  }
  // Agent reporter leaves: fold into the full names from the FAIL blocks.
  for (const l of leaves) {
    const full = [...tests.values()].find((t) => t.file === l.file && (t.name === l.name || t.name.endsWith(` > ${l.name}`)));
    if (full) { if (l.duration_ms != null) full.duration_ms = l.duration_ms; } else put(l.file, l.name, { status: l.status, duration_ms: l.duration_ms });
  }
  const results = [...tests.values()];
  if (!results.length && !counts) return null;
  return { framework, results, summary: summarize(results, counts) };
}
