// Jest (KERB-V2 5.4): the default and verbose reporters (text), and `--json` output (a file
// from --outputFile, or JSON on stdout). Vitest's JSON reporter uses the same shape. Recorded
// with Jest 29.7 and Vitest 3.2.7.
//   "FAIL src/cart.test.js" / "PASS …", verbose "  ✓ adds items (2 ms)" nested under describe
//   lines, failures "  ● cart › applies discount" … "at Object.toBe (src/cart.test.js:5:56)",
//   summary "Tests:       2 failed, 1 skipped, 3 passed, 6 total"
import { lines, repoPath, summarize, STATUS } from './common.js';

export const framework = 'jest';
const SYM = { '✓': 'pass', '√': 'pass', '✕': 'fail', '×': 'fail', '○': 'skip', '✎': 'skip' };

export function parse(text, ctx) {
  if (/^\s*\{/.test(text) && text.includes('"testResults"')) return parseJson(text, ctx);
  if (!/(^|\n)(PASS|FAIL) \S/.test(text) || !/(^|\n)Tests:\s+/.test(text)) return null;
  const tests = new Map();
  const put = (file, name, patch) => {
    const k = `${file}::${name}`;
    tests.set(k, { file, name, status: 'pass', location: null, message: null, duration_ms: null, ...(tests.get(k) || {}), ...patch });
  };
  let file = null;
  let stack = [];
  let bullet = null;
  let counts = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(PASS|FAIL) (\S+)/.exec(line))) { file = repoPath(m[2], ctx); stack = []; bullet = null; continue; }
    if (!file) continue;
    if ((m = /^(\s+)([✓√✕×○✎]) (?:(?:skipped|todo) )?(.+?)(?: \((\d+(?:\.\d+)?) ms\))?$/.exec(line)) && !line.includes('●')) {
      const depth = m[1].length / 2 - 1;
      const name = [...stack.slice(0, depth), m[3]].join(' > ');
      put(file, name, { status: SYM[m[2]], duration_ms: m[4] ? Number(m[4]) : null });
      continue;
    }
    if ((m = /^ {2}● (.+)$/.exec(line))) {
      const name = m[1].split(' › ').join(' > ');
      if (/^Test suite failed to run$/.test(name)) { bullet = null; continue; }
      put(file, name, { status: 'fail' });
      bullet = { key: `${file}::${name}`, expectMessage: true };
      continue;
    }
    if (bullet) {
      const t = tests.get(bullet.key);
      if (bullet.expectMessage && line.trim()) { t.message = t.message || line.trim(); bullet.expectMessage = false; continue; }
      if ((m = /^\s+at .*?\(?([^\s()]+?):(\d+):\d+\)?$/.exec(line)) && !line.includes('node_modules')) {
        if (!t.location) t.location = `${repoPath(m[1], ctx)}:${m[2]}`;
        continue;
      }
    }
    if ((m = /^(\s+)([^\s●✓√✕×○✎].*)$/.exec(line)) && !bullet && !/^\s+at /.test(line)) {
      const depth = m[1].length / 2 - 1;
      if (depth >= 0 && depth < 20) stack = [...stack.slice(0, depth), m[2].trim()];
      continue;
    }
    if ((m = /^Tests:\s+(.+)$/.exec(line))) {
      const part = (w) => { const x = new RegExp(`(\\d+) ${w}`).exec(m[1]); return x ? Number(x[1]) : 0; };
      counts = { failed: part('failed'), passed: part('passed'), skipped: part('skipped') + part('todo'), total: part('total') };
      file = null;
    }
  }
  const results = [...tests.values()];
  return { framework, results, summary: summarize(results, counts) };
}

/** Jest `--json` output, or Vitest's JSON reporter (same shape; told apart by its paths). */
export function parseJson(body, ctx) {
  let j;
  try { j = JSON.parse(body); } catch { return null; }
  if (!j || !Array.isArray(j.testResults)) return null;
  const vitestShape = j.testResults.some((f) => Array.isArray(f.assertionResults) && f.assertionResults.some((a) => 'meta' in a || a.duration !== undefined && !('invocations' in a)));
  const results = [];
  for (const f of j.testResults) {
    const file = repoPath(f.name || f.testFilePath, ctx);
    for (const a of f.assertionResults || []) {
      const name = [...(a.ancestorTitles || []), a.title].join(' > ');
      const msg = (a.failureMessages || [])[0] || null;
      const line = a.location && a.location.line ? a.location.line : stackLine(msg);
      const loc = line ? `${file}:${line}` : null;
      results.push({ file, name, status: STATUS[a.status] || 'error', location: loc, message: msg, duration_ms: Number.isFinite(a.duration) ? a.duration : null });
    }
  }
  return { framework: vitestShape ? 'vitest' : framework, results, summary: summarize(results, { passed: j.numPassedTests, failed: j.numFailedTests, skipped: (j.numPendingTests || 0) + (j.numTodoTests || 0), total: j.numTotalTests }) };
}

/** Line number of the first stack frame outside node_modules in a failure message. */
function stackLine(msg) {
  if (!msg) return null;
  for (const l of msg.split('\n')) {
    if (!/^\s+at /.test(l) || l.includes('node_modules') || l.includes('node:')) continue;
    const m = /:(\d+):\d+\)?\s*$/.exec(l);
    if (m) return Number(m[1]);
  }
  return null;
}
