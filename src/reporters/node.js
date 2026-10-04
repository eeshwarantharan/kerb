// Node's built-in test runner (`node --test`) (KERB-V2 5.4): the TAP reporter (Node 20's
// default when output isn't a terminal) and the spec reporter. Recorded with Node 20.12.
//   TAP:  "# Subtest: name", "    not ok 2 - applies discount", YAML with "location: '…:5:3'",
//         "error: |-" and "type: 'suite'"; "# tests 4" … summary lines
//   spec: "▶ cart", "  ✔ adds items (0.15ms)", "  ✖ applies discount (1.02ms)",
//         "  ﹣ handles currency (0.06ms) # SKIP", "ℹ tests 4"; failures repeat after
//         "✖ failing tests:" with "test at cart.test.js:5:3"
// Neither reporter says which file a passing test is in (TAP gives locations for failures only),
// so test ids use the command's single test file when it names one, else none, for every
// result alike; locations are kept as reported.
import { lines, repoPath, summarize } from './common.js';

export const framework = 'node';

function counts(text) {
  const c = {};
  for (const [k, w] of [['total', 'tests'], ['passed', 'pass'], ['failed', 'fail'], ['skipped', 'skipped']]) {
    const m = new RegExp(`(?:^|\\n)(?:# |ℹ )${w} (\\d+)`).exec(text);
    if (m) c[k] = Number(m[1]);
  }
  const todo = /(?:^|\n)(?:# |ℹ )todo (\d+)/.exec(text);
  if (todo && c.skipped != null) c.skipped += Number(todo[1]);
  return Object.keys(c).length ? c : null;
}

export function parse(text, ctx) {
  if (/(^|\n)TAP version \d+/.test(text)) return parseTap(text, ctx);
  if (/(^|\n)ℹ tests \d+/.test(text)) return parseSpec(text, ctx);
  // The end of a TAP run whose start was cut off (`node --test | tail -30`): the summary block
  // alone, which nothing else prints. Counts only, no per-test results.
  if (/(^|\n)# tests \d+\n# suites \d+\n# pass \d+\n# fail \d+/.test(text)) return { framework, results: [], summary: counts(text) };
  return null;
}

function commandFile(ctx) {
  const files = String(ctx.command || '').split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, '')).filter((w) => /\.(test|spec)\.[cm]?[jt]s$|(^|\/)test\.[cm]?[jt]s$/.test(w));
  return files.length === 1 ? repoPath(files[0], ctx) : '';
}

function parseTap(text, ctx) {
  const file = commandFile(ctx);
  const results = [];
  const names = [];
  let cur = null; // the result whose YAML block follows
  let inError = false;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(\s*)# Subtest: (.+)$/.exec(line))) { names[m[1].length / 4] = m[2]; names.length = m[1].length / 4 + 1; cur = null; continue; }
    if ((m = /^(\s*)(not ok|ok) \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/.exec(line))) {
      const depth = m[1].length / 4;
      const name = [...names.slice(0, depth), m[3]].join(' > ');
      cur = { file, name, status: m[4] ? 'skip' : m[2] === 'ok' ? 'pass' : 'fail', location: null, message: null, duration_ms: null, suite: false };
      results.push(cur);
      inError = false;
      continue;
    }
    if (!cur) continue;
    if ((m = /^\s+duration_ms: ([\d.]+)/.exec(line))) cur.duration_ms = Number(m[1]);
    else if ((m = /^\s+type: 'suite'/.exec(line))) cur.suite = true;
    else if ((m = /^\s+location: '(.+?):(\d+):\d+'/.exec(line))) cur.location = `${repoPath(m[1], ctx)}:${m[2]}`;
    else if ((m = /^\s+error: '(.*)'$/.exec(line))) cur.message = m[1];
    else if (/^\s+error: \|-?$/.test(line)) inError = true;
    else if (inError && line.trim()) { cur.message = cur.message || line.trim(); inError = false; }
  }
  const tests = results.filter((r) => !r.suite);
  if (!tests.length) return null;
  return { framework, results: tests.map(({ suite, ...r }) => r), summary: summarize(tests, counts(text)) };
}

function parseSpec(text, ctx) {
  const file = commandFile(ctx);
  const results = [];
  const stack = [];
  let last = null;
  let inFailures = false;
  let locNext = null;
  for (const line of lines(text, ctx.deadline)) {
    if (/^✖ failing tests:/.test(line)) { inFailures = true; continue; }
    let m;
    if (inFailures) {
      if ((m = /^test at (.+?):(\d+):\d+$/.exec(line))) { locNext = `${repoPath(m[1], ctx)}:${m[2]}`; continue; }
      if (locNext && (m = /^✖ (.+?)(?: \([\d.]+ms\))?$/.exec(line))) {
        const leaf = m[1];
        const r = results.find((x) => x.status === 'fail' && (x.name === leaf || x.name.endsWith(` > ${leaf}`)) && !x.location);
        if (r) r.location = locNext;
        locNext = null;
      }
      continue;
    }
    if ((m = /^(\s*)▶ (.+?)(?: \([\d.]+ms\))?$/.exec(line))) {
      const depth = m[1].length / 2;
      if (/\([\d.]+ms\)$/.test(line)) { stack.length = depth; continue; } // suite end line
      stack[depth] = m[2];
      stack.length = depth + 1;
      continue;
    }
    if ((m = /^(\s*)([✔✖﹣]) (.+?)(?: \(([\d.]+)ms\))?(?: # (SKIP|TODO).*)?$/.exec(line))) {
      const depth = m[1].length / 2;
      const name = [...stack.slice(0, depth), m[3]].join(' > ');
      last = { file, name, status: m[5] || m[2] === '﹣' ? 'skip' : m[2] === '✔' ? 'pass' : 'fail', location: null, message: null, duration_ms: m[4] ? Number(m[4]) : null };
      results.push(last);
      continue;
    }
    if (last && last.status === 'fail' && !last.message && line.trim() && !/^\s+at /.test(line)) last.message = line.trim();
  }
  if (!results.length) return null;
  return { framework, results, summary: summarize(results, counts(text)) };
}
