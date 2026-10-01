// DL · Delta, CV · Convergence and oscillation, LG · Ledger (KERB-V2 7.1, 7.3, 7.4, 6.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, shPath, ROOT } from './helpers.js';
import { evaluateRules } from '../src/loop/rules.js';
import { progress, findCycle, series } from '../src/insight/converge.js';
import { renderLedger, MAX_BYTES } from '../src/insight/ledger.js';
import { Store } from '../src/store/jsonl.js';

/** pytest -v output for the given tests. */
function pytestText({ pass = [], fail = [], error = [] }) {
  const lines = ['============================= test session starts ==============================', 'collected items', ''];
  for (const t of pass) lines.push(`tests/test_cart.py::${t} PASSED`);
  for (const t of fail) lines.push(`tests/test_cart.py::${t} FAILED`);
  for (const t of error) lines.push(`tests/test_cart.py::${t} ERROR`);
  lines.push('=========================== short test summary info ============================');
  for (const t of fail) lines.push(`FAILED tests/test_cart.py::${t} - assert ${t} == ok`);
  const parts = [fail.length && `${fail.length} failed`, pass.length && `${pass.length} passed`, error.length && `${error.length} errors`].filter(Boolean).join(', ');
  lines.push(`========================= ${parts || 'no tests ran'} in 0.01s =========================`);
  return `${lines.join('\n')}\n`;
}

/** A check command whose output is set per run, kept outside the repo so it never changes the state. */
function suite(repo) {
  const out = shPath(repo.home, 'out.txt');
  const code = shPath(repo.home, 'code');
  const cmd = `cat ${out}; exit $(cat ${code})`;
  let edit = 0;
  return {
    cmd,
    key: `.::${cmd}`,
    /** Edit the repo (a new state) unless `same`, then run. */
    run(res, { same = false, args = [] } = {}) {
      if (!same) repo.write('src/cart.py', `v = ${++edit}\n`);
      fs.writeFileSync(out, pytestText(res));
      fs.writeFileSync(code, (res.fail || []).length || (res.error || []).length ? '1' : '0');
      return repo.kerb(['run', '--class', 'check', ...args, '--', cmd]);
    },
    edit(n) { repo.write('src/cart.py', `v = ${n}\n`); },
    write(res) { fs.writeFileSync(out, pytestText(res)); fs.writeFileSync(code, (res.fail || []).length ? '1' : '0'); },
  };
}

const deltaOf = (r) => r.stderr.split('\n').filter((l) => /^kerb: cat |^ {6}[+!~-] |^ {6}… /.test(l));

test('DL1 fixed, still failing and new are right across two runs', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ pass: ['test_a'], fail: ['test_b', 'test_c', 'test_d'] });
  const r = s.run({ pass: ['test_a', 'test_b', 'test_c'], fail: ['test_d', 'test_e'] });
  const d = deltaOf(r);
  assert.match(d[0], /^kerb: cat .* · 2 failing \(was 3\) · exit 1 · log \.kerb\/logs\//);
  assert.ok(d.includes('      + fixed: test_b; test_c'), d.join('\n'));
  assert.ok(d.some((l) => /^ {6}! still failing: test_d · assert test_d == ok$/.test(l)));
  assert.ok(d.some((l) => /^ {6}- new failure: test_e/.test(l)));
  assert.doesNotMatch(r.stderr, /^kerb: exit 1 ·/m, 'the delta replaces the generic footer');
  const green = s.run({ pass: ['test_a', 'test_b', 'test_c', 'test_d', 'test_e'] });
  assert.match(deltaOf(green)[0], /all passing \(was 2 failing\)/);
  assert.equal(deltaOf(s.run({ pass: ['test_a', 'test_b', 'test_c', 'test_d', 'test_e'] })).length, 0, 'green after green: nothing to say');
});

test('DL2 when the test set shrinks, only explicit passes count as fixed', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ pass: ['test_a', 'test_b'], fail: ['test_c', 'test_d'] });
  const d = deltaOf(s.run({ pass: ['test_c'], fail: [] }));
  assert.ok(d.some((l) => l === '      + fixed: test_c'), d.join('\n'));
  assert.ok(!d.some((l) => /test_d/.test(l)), 'test_d did not run: not "fixed"');
});

test('DL3 flaky: a test that passed and failed on the same files', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ pass: ['test_x', 'test_y'] });
  const d = deltaOf(s.run({ pass: ['test_y'], fail: ['test_x'] }, { same: true }));
  assert.ok(d.some((l) => l === '      ~ flaky: test_x (passed and failed on the same files)'), d.join('\n'));
  assert.ok(!d.some((l) => /new failure: test_x/.test(l)));
});

test('DL4 flaky tests are left out of the breaker fingerprint', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ pass: ['test_x'] });
  s.run({ fail: ['test_x'] }, { same: true }); // now flaky
  for (let i = 0; i < 3; i++) assert.equal(s.run({ fail: ['test_x'] }).code, 1);
  const r = s.run({ fail: ['test_x'] });
  assert.doesNotMatch(r.stderr, /breaker_open/, 'failures of a flaky test never open the breaker');
  const other = makeRepo({ git: true });
  const t = suite(other);
  for (let i = 0; i < 3; i++) t.run({ fail: ['test_y'] });
  assert.match(t.run({ fail: ['test_y'] }).stderr, /kerb: breaker_open/);
});

test('DL5 at most 8 lines, then the "more" line', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ fail: ['test_0'] });
  const many = Array.from({ length: 12 }, (_, i) => `test_n${i}`);
  const d = deltaOf(s.run({ fail: ['test_0', ...many] }));
  assert.equal(d.length, 8, d.join('\n'));
  assert.match(d[7], /^ {6}… and \d+ more \(kerb why \S+\)$/);
  const runId = /kerb why (\S+)\)/.exec(d[7])[1];
  assert.match(repo.kerb(['why', runId]).stdout, /fail {2}pytest:tests\/test_cart\.py::test_n11/);
});

test('DL6 the first run of a key: a summary with the first three failures', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  const d = deltaOf(s.run({ pass: ['test_a'], fail: ['test_b', 'test_c', 'test_d', 'test_e'] }));
  assert.match(d[0], /^kerb: cat .* · 4 failing of 5 · exit 1/);
  assert.equal(d.filter((l) => l.startsWith('      ! ')).length, 3);
  assert.match(d[d.length - 1], /… and 1 more/);
});

test('DL7 deltas in hook context are monochrome', () => {
  const repo = makeRepo({ git: true });
  const p = (id) => ({ session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'pytest -v' }, tool_use_id: id });
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('a')) });
  const out = repo.kerb(['hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p('a'), error: `Exit code 1\n${pytestText({ fail: ['test_a', 'test_b'] })}` }), env: { FORCE_COLOR: '1' } });
  const ctxText = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctxText, /^kerb: pytest -v · 2 failing of 2/);
  assert.doesNotMatch(ctxText, /\x1b\[/);
});

test('DL8 diagnostics (tsc) produce deltas', () => {
  const repo = makeRepo({ git: true });
  const out = shPath(repo.home, 'tsc.txt');
  const cmd = `cat ${out}; exit 2`;
  fs.writeFileSync(out, "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(4,1): error TS2304: Cannot find name 'x'.\n");
  repo.kerb(['run', '--class', 'check', '--', cmd]);
  repo.write('src/a.ts', 'fixed\n');
  fs.writeFileSync(out, "src/b.ts(4,1): error TS2304: Cannot find name 'x'.\nsrc/c.ts(2,3): error TS2551: Property 'y' does not exist.\n");
  const d = deltaOf(repo.kerb(['run', '--class', 'check', '--', cmd]));
  assert.ok(d.includes('      + fixed: TS2322'), d.join('\n'));
  assert.ok(d.some((l) => /! still failing: TS2304 · src\/b\.ts:4/.test(l)));
  assert.ok(d.some((l) => /- new failure: TS2551 · src\/c\.ts:2/.test(l)));
});

test('DL9 no delta after a successful non-check command', () => {
  const repo = makeRepo({ git: true });
  const p = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'l1' };
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) });
  assert.equal(repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...p, tool_response: { stdout: 'a.js', stderr: '', interrupted: false } }) }).stdout, '');
  assert.equal(repo.kerb(['run', '--', 'echo hi']).stderr, '');
});

// ---- Convergence and oscillation (synthetic records) ----

let n = 0;
function run(key, { state, exit = 1, failed = null, kind = 'ordinary', ts }) {
  const id = `r${String(++n).padStart(4, '0')}`;
  const t = ts ?? 1_700_000_000_000 + n * 1000;
  return [
    { type: 'start', id, ts: t, key, class: 'check', pre_hash: state, env_stamp: 'e' },
    { type: 'end', id, ts: t + 500, exit, class_result: exit === 0 ? 'ok' : 'failure', post_hash: state, key, class: 'check', env_stamp: 'e',
      failure_kind: exit === 0 ? null : kind, fingerprint: `fp-${failed}`, tests_summary: failed == null ? null : { failed, passed: 1, skipped: 0, errors: 0, total: failed + 1 } },
  ];
}
const st = (c) => `st_${c.repeat(16)}`;

test('CV1 converging, stalled, oscillating, diverging and green on fixture series', () => {
  const k = '.::npm test';
  const conv = [run(k, { state: st('1'), failed: 5 }), run(k, { state: st('2'), failed: 3 }), run(k, { state: st('3'), failed: 3 }), run(k, { state: st('4'), failed: 1 })].flat();
  assert.equal(progress(conv, k).signal, 'converging');
  assert.equal(series(progress(conv, k).counts), '5 → 3 → 3 → 1');
  const stalled = [run(k, { state: st('1'), failed: 3 }), run(k, { state: st('2'), failed: 3 }), run(k, { state: st('3'), failed: 3 })].flat();
  assert.equal(progress(stalled, k).signal, 'stalled');
  const osc = [run(k, { state: st('a'), failed: 2 }), run(k, { state: st('b'), failed: 1 }), run(k, { state: st('a'), failed: 2 }), run(k, { state: st('b'), failed: 1 })].flat();
  assert.equal(progress(osc, k).signal, 'oscillating');
  const div = [run(k, { state: st('1'), failed: 1 }), run(k, { state: st('2'), failed: 2 }), run(k, { state: st('3'), failed: 4 })].flat();
  assert.equal(progress(div, k).signal, 'diverging');
  const green = [...conv, ...run(k, { state: st('5'), exit: 0, failed: 0 })];
  assert.equal(progress(green, k).signal, 'green');
  assert.equal(series(progress(green, k).counts), '5 → 3 → 3 → 1 → 0');
});

const rules = (recs, key, hash) => evaluateRules({ recs, key, hash, envStamp: 'e', nowTs: Date.now(), policy: {}, command: 'npm test' });

test('CV2 an oscillation refusal fires on a 2-state cycle', () => {
  const k = '.::npm test';
  const recs = [run(k, { state: st('a') }), run(k, { state: st('b') }), run(k, { state: st('a') }), run(k, { state: st('b') })].flat();
  const v = rules(recs, k, st('a'));
  assert.equal(v.refusal.reason, 'oscillating');
  assert.equal(v.refusal.summary, 'your last 4 attempts cycle between 2 file states, both failing');
  assert.match(v.refusal.evidence, /^states: st_aaaa \(attempts 1, 3\) and st_bbbb \(attempts 2, 4\)/);
  assert.match(v.refusal.next, /stop editing this back and forth/);
  assert.equal(rules([run(k, { state: st('a') }), run(k, { state: st('b') })].flat(), k, st('a')).refusal.reason, 'deja_vu', 'one return is deja_vu');
});

test('CV3 and on 3- and 4-state cycles', () => {
  const k = '.::npm test';
  const three = ['a', 'b', 'c', 'a', 'b'].flatMap((c) => run(k, { state: st(c) }));
  assert.match(rules(three, k, st('c')).refusal.summary, /cycle between 3 file states, all failing/);
  const four = ['a', 'b', 'c', 'd', 'a', 'b'].flatMap((c) => run(k, { state: st(c) }));
  assert.match(rules(four, k, st('c')).refusal.summary, /your last 6 attempts cycle between 4 file states/);
  assert.equal(findCycle(['a', 'b', 'c', 'd', 'a', 'b'].map((c) => ({ finished: true, exit: 1, class: 'check', class_result: 'failure', post_hash: st(c) }))).next, st('c'));
});

test('CV4 no oscillation when a run in the cycle is transient or environment', () => {
  const k = '.::npm test';
  for (const kind of ['transient', 'environment']) {
    const recs = [run(k, { state: st('a') }), run(k, { state: st('b'), kind }), run(k, { state: st('a') }), run(k, { state: st('b') })].flat();
    const v = rules(recs, k, st('a'));
    assert.notEqual(v && v.refusal.reason, 'oscillating', kind);
  }
});

test('CV5 rule order: identical_retry, then deja_vu / oscillating, then breaker_open', () => {
  const k = '.::npm test';
  const recs = [run(k, { state: st('a'), failed: 1 }), run(k, { state: st('b'), failed: 1 }), run(k, { state: st('a'), failed: 1 }), run(k, { state: st('b'), failed: 1 })].flat();
  assert.equal(rules(recs, k, st('b')).refusal.reason, 'identical_retry', 'the same state as the latest run');
  assert.equal(rules(recs, k, st('a')).refusal.reason, 'oscillating', 'before breaker_open, which also matches');
  assert.equal(rules(recs, k, st('z')).refusal.reason, 'breaker_open');
});

test('CV6 kerb progress, text and JSON; CV7 the status line series', () => {
  const repo = makeRepo({ git: true });
  const s = suite(repo);
  s.run({ fail: ['test_a', 'test_b', 'test_c'] });
  s.run({ pass: ['test_a'], fail: ['test_b', 'test_c'] });
  s.run({ pass: ['test_a', 'test_b'], fail: ['test_c'] });
  const text = repo.kerb(['progress']).stdout;
  assert.match(text, /^cat .*: 3 → 2 → 1 \(converging\)$/m);
  const j = repo.kerb(['progress', '--json']).json;
  assert.deepEqual(j.keys[0].counts, [3, 2, 1]);
  assert.equal(j.keys[0].signal, 'converging');
  assert.match(repo.kerb(['statusline']).stdout, /tests: red · failing 3→2→1/);
});

test('CV8 the oscillation message names the cycling files; CV9 shadow records it as would-refuse', () => {
  const repo = makeRepo({ git: true });
  repo.kerb(['init', '--agent', 'other']); // shadow mode
  const s = suite(repo);
  for (const v of [1, 2, 1, 2]) { s.edit(v); s.write({ fail: ['test_a'] }); repo.kerb(['run', '--class', 'check', '--', s.cmd]); }
  s.edit(1);
  const r = repo.kerb(['run', '--class', 'check', '--', s.cmd]);
  assert.equal(r.code, 1, 'shadow: it ran');
  const w = records(repo.dir).filter((x) => x.type === 'would_refuse').pop();
  assert.equal(w.reason, 'oscillating');
  assert.match(w.evidence, /changed: src\/cart\.py/);
});

// ---- Ledger ----

test('LG1 the ledger stays within 250 tokens; LG2 it is derived only from records', () => {
  const repo = makeRepo({ git: true });
  for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
    const s = suite(repo);
    const cmd = `${s.cmd} # ${name} ${'x'.repeat(60)}`;
    for (let i = 0; i < 4; i++) { repo.write(`src/${name}.py`, `${i}\n`); fs.writeFileSync(path.join(repo.home, 'out.txt'), pytestText({ fail: ['test_a'] })); fs.writeFileSync(path.join(repo.home, 'code'), '1'); repo.kerb(['run', '--class', 'check', '--', cmd]); }
  }
  const store = new Store(repo.dir);
  const recs = store.read();
  const text = renderLedger({ root: repo.dir, store, recs, nowTs: Date.now(), branch: 'main' });
  assert.ok(Buffer.byteLength(text) <= MAX_BYTES, `${Buffer.byteLength(text)} bytes`);
  assert.match(text, /^kerb ledger · branch main · since \d\d:\d\d/);
  assert.equal(renderLedger({ root: repo.dir, store, recs, nowTs: Date.now(), branch: 'main' }), text, 'deterministic');
  const src = fs.readFileSync(path.join(ROOT, 'src/insight/ledger.js'), 'utf8');
  assert.doesNotMatch(src, /fetch\(|node:https?|anthropic|openai/i);
});

test('LG5 the ledger has attempts, edits, returns and the last green with the current status', () => {
  const repo = makeRepo({ git: true });
  repo.kerb(['init', '--agent', 'other']); // shadow mode, so the return to attempt 1's files runs
  const s = suite(repo);
  s.edit(0); s.write({ pass: ['test_a'] }); repo.kerb(['run', '--class', 'check', '--', s.cmd]); // green
  s.edit(1); s.write({ fail: ['test_a', 'test_b', 'test_c'] }); repo.kerb(['run', '--class', 'check', '--', s.cmd]);
  repo.write('src/other.py', 'x\n'); s.write({ fail: ['test_a', 'test_b'] }); repo.kerb(['run', '--class', 'check', '--', s.cmd]);
  fs.rmSync(path.join(repo.dir, 'src/other.py')); s.write({ fail: ['test_a', 'test_b', 'test_c'] }); repo.kerb(['run', '--class', 'check', '--', s.cmd]);
  const t = repo.kerb(['ledger']).stdout;
  assert.match(t, /^ {2}cat .*: 3 attempts · failing 3 → 2 → 3/m);
  assert.match(t, /edited across attempts: other\.py \(2, 3\)/);
  assert.match(t, /attempt 3 returned to the files of attempt 1/);
  assert.match(t, /last green: \d\d:\d\d \(st_\w{4}\) · now: red/);
});

test('LG6 a known-fix pointer when one matches', { todo: 'proven fixes arrive in milestone E (E4)' }, () => {});

test('LG7 best-effort agents get the ledger through the instructions block', () => {
  const repo = makeRepo({ git: true });
  repo.kerb(['init', '--agent', 'other']);
  assert.match(repo.read('AGENTS.md'), /\.kerb\/ledger\.md/);
  const s = suite(repo);
  s.run({ fail: ['test_a'] });
  assert.match(repo.read('.kerb/ledger.md'), /^kerb ledger · branch main/);
});
