// go test (KERB-V2 5.4): the `-json` event stream (test2json) and the text output.
//   -json:  {"Action":"fail","Package":"example.com/shop/cart","Test":"TestDiscount","Elapsed":0}
//   text:   "--- FAIL: TestDiscount (0.00s)", "    cart_test.go:12: got 100, want 90",
//           "FAIL\texample.com/shop/cart\t0.004s", "ok  \texample.com/shop/user\t0.002s"
// Test ids use the package import path as the file: go reports tests per package.
import { lines, summarize } from './common.js';

export const framework = 'go';
const MAP = { pass: 'pass', fail: 'fail', skip: 'skip', PASS: 'pass', FAIL: 'fail', SKIP: 'skip' };

export function parse(text, ctx) {
  if (/(^|\n)\{"Time":"[^"]+","Action":"/.test(text) || /(^|\n)\{"Action":"/.test(text)) return parseJson(text, ctx);
  if (!/(^|\n)\s*--- (PASS|FAIL|SKIP): /.test(text) && !/(^|\n)(ok|FAIL)\s+\S+\s+[\d.]+s/.test(text)) return null;
  const results = [];
  let pending = []; // results waiting for their package line
  let last = null;
  let running = null; // -v: messages come after "=== RUN" and before "--- FAIL"
  const early = new Map();
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^=== (?:RUN|CONT|PAUSE)\s+(\S+)/.exec(line))) { running = m[1]; last = null; continue; }
    if ((m = /^\s*--- (PASS|FAIL|SKIP): (\S+) \(([\d.]+)s\)/.exec(line))) {
      last = { file: '', name: m[2], status: MAP[m[1]], location: null, message: null, duration_ms: Number(m[3]) * 1000 };
      const e = early.get(m[2]);
      if (e && last.status === 'fail') Object.assign(last, e);
      pending.push(last);
      running = null;
      continue;
    }
    if ((m = /^\s+(\S+\.go):(\d+): (.*)$/.exec(line))) {
      if (last && last.status === 'fail' && !last.message) { last.message = m[3]; last.location = `${m[1]}:${m[2]}`; } else if (running && !early.has(running)) early.set(running, { message: m[3], location: `${m[1]}:${m[2]}` });
      continue;
    }
    if ((m = /^(ok|FAIL)\s+(\S+)\s+(?:[\d.]+s|\(cached\)|\[)/.exec(line))) {
      for (const r of pending) { r.file = m[2]; results.push(r); }
      pending = [];
      last = null;
      early.clear();
    }
  }
  results.push(...pending);
  if (!results.length) return null;
  return { framework, results, summary: summarize(results) };
}

function parseJson(text, ctx) {
  const tests = new Map();
  for (const line of lines(text, ctx.deadline)) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e.Test) continue;
    const k = `${e.Package}::${e.Test}`;
    const t = tests.get(k) || { file: e.Package || '', name: e.Test, status: null, location: null, message: null, duration_ms: null };
    if (MAP[e.Action]) { t.status = MAP[e.Action]; if (Number.isFinite(e.Elapsed)) t.duration_ms = e.Elapsed * 1000; }
    if (e.Action === 'output' && !t.message) {
      const m = /^\s+(\S+\.go):(\d+): (.*)$/.exec(String(e.Output || '').replace(/\n$/, ''));
      if (m) { t.message = m[3]; t.location = `${m[1]}:${m[2]}`; }
    }
    tests.set(k, t);
  }
  const results = [...tests.values()].filter((t) => t.status);
  if (!results.length) return null;
  return { framework, results, summary: summarize(results) };
}
