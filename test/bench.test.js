// Benchmark v2 (KERB-V2 15): tasks, harness, transcript metrics, the refusal judge, the cause
// benchmark's scoring, and the launch gate. These test the instruments, not Kerb's numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, tmpDir, waitFor, baseEnv, makeRepo } from './helpers.js';
import { TASKS } from '../bench/tasks.js';
import { validateTask, available } from '../bench/sandbox.js';
import { greenMetrics, checkPattern } from '../bench/transcript.js';
import { judgeRun } from '../bench/judge.js';
import { covers, judge, summarize } from '../bench/cause.js';
import { analyze, bootstrap } from '../bench/analyze.js';

test('the benchmark has 30+ tasks across Node, Python and Go, with every category section 15 asks for', () => {
  assert.ok(TASKS.length >= 30, `${TASKS.length} tasks`);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  for (const lang of ['node', 'python', 'go']) assert.ok(TASKS.some((t) => t.lang === lang), lang);
  for (const c of ['wall', 'loop', 'transient', 'dependency', 'noise', 'hang', 'regression', 'compaction', 'environment', 'slow', 'scale', 'static']) assert.ok(TASKS.some((t) => t.category === c), c);
  assert.ok(TASKS.some((t) => t.id.startsWith('monorepo')));
  for (const t of TASKS) {
    assert.ok(t.prompt && t.test && t.check, t.id);
    assert.ok(t.solve || ['npm-mirror-install', 'pip-mirror-install', 'slow-database'].includes(t.id), `${t.id} has a reference solution`);
  }
});

test('each quick task fails as given and passes with its reference solution', { timeout: 300_000 }, () => {
  const have = available();
  const quick = TASKS.filter((t) => !t.slow && t.solve && (t.needs || []).every((n) => have.has(n)));
  assert.ok(quick.length >= 20, `${quick.length} quick tasks`);
  for (const t of quick) {
    // A clean environment: a child `node --test` must not see this runner's NODE_TEST_CONTEXT.
    const r = validateTask(t, {}, baseEnv());
    assert.ok(r.ok, `${t.id}: ${r.problems.join('; ')}`);
  }
});

test('seeded culprits name lines the edits changed', () => {
  for (const t of TASKS.filter((x) => x.seeded)) {
    const d = tmpDir('kerb-seed-');
    t.setup(d, {});
    const before = Object.fromEntries(t.seeded.culprits.map((c) => { const f = c.slice(0, c.lastIndexOf(':')); return [f, fs.readFileSync(path.join(d, f), 'utf8').split('\n')]; }));
    t.edits(d, {});
    for (const c of t.seeded.culprits) {
      const f = c.slice(0, c.lastIndexOf(':'));
      const line = fs.readFileSync(path.join(d, f), 'utf8').split('\n')[Number(c.slice(c.lastIndexOf(':') + 1)) - 1];
      assert.ok(line && line.trim() && !before[f].includes(line), `${t.id}: ${c} is "${line}", which the edits didn't change`);
    }
  }
});

test('the harness runs the plain, skill and v2 arms and writes rows and a summary', { timeout: 180_000 }, () => {
  const out = tmpDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/run.js'), '--tasks', 'fix-test-sum', '--runs', '1', '--arms', 'plain,skill,v2', '--out', out,
    '--agent-cmd', `${process.execPath} ${path.join(ROOT, 'bench/fake-agent.js')}`], { encoding: 'utf8', env: baseEnv() });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => x.arm), ['plain', 'skill', 'v2']);
  const v2 = rows.find((x) => x.arm === 'v2');
  assert.equal(rows.find((x) => x.arm === 'plain').refusals.length, 0);
  assert.equal(v2.refusals.length, 1, 'the naive second run is refused');
  assert.equal(v2.refusals[0].reason, 'identical_retry');
  assert.equal(v2.refusals[0].correct, true, 'judged by replay: the failure repeats');
  assert.match(fs.readFileSync(path.join(rows.find((x) => x.arm === 'skill').dir, 'AGENTS.md'), 'utf8'), /# Working rules/);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.per_arm.v2.runs, 1);
  assert.ok('success_within_1_point' in summary.launch_gate);
  assert.equal(summary.launch_gate.pass, false, 'one fake run never passes the gate');
});

test('transcript metrics: attempts, tokens and time to green', () => {
  const t = (s) => new Date(Date.UTC(2026, 9, 1, 12, 0, s)).toISOString();
  const call = (id, s, input, output, tool) => ({ type: 'assistant', timestamp: t(s), message: { id, usage: { input_tokens: input, cache_read_input_tokens: 0, output_tokens: output }, content: tool ? [{ type: 'tool_use', id: `tu-${id}`, name: 'Bash', input: { command: tool } }] : [] } });
  const result = (id, s, isError, text) => ({ type: 'user', timestamp: t(s), message: { content: [{ type: 'tool_result', tool_use_id: `tu-${id}`, is_error: isError, content: text }] } });
  const recs = [
    call('a', 0, 1000, 50, 'npm test'), result('a', 5, true, 'Exit code 1\n1 failing'),
    call('b', 10, 1200, 60, 'sed -i s/x/y/ src/a.js'), result('b', 11, false, ''),
    call('c', 20, 1400, 70, 'kerb run -- npm test'), result('c', 30, false, 'ok'),
    call('d', 40, 1500, 20),
  ];
  const g = greenMetrics(recs, checkPattern('npm test'));
  assert.deepEqual({ attempts: g.attempts, to: g.attempts_to_green, tokens: g.tokens_to_green, ms: g.ms_to_green, green: g.green, total: g.tokens },
    { attempts: 2, to: 2, tokens: 1050 + 1260 + 1470, ms: 30_000, green: true, total: 1050 + 1260 + 1470 + 1520 });
  // A Kerb cached answer that says the recorded result passed counts as green.
  const cached = [call('x', 0, 10, 1, 'tsc --noEmit'), result('x', 1, true, 'kerb: cached · same files\n      result: passed\n      next: no need to re-run')];
  assert.equal(greenMetrics(cached, checkPattern('tsc --noEmit')).attempts_to_green, 1);
  assert.equal(checkPattern('npm test').test('npm testify'), false);
});

test('the judge replays identical retries: correct when the failure repeats', () => {
  const repo = makeRepo({ git: true, config: { mode: 'enforce' }, files: { 'a.txt': '1\n' } });
  const cmd = 'cat a.txt; exit 3';
  repo.kerb(['run', '--class', 'check', '--', cmd]);
  assert.equal(repo.kerb(['run', '--class', 'check', '--', cmd]).code, 75);
  const [j] = judgeRun(repo.dir, { env: repo.env });
  assert.equal(j.reason, 'identical_retry');
  assert.equal(j.correct, true, j.why);
  assert.match(j.why, /replayed twice: exit 3, as recorded/);
});

test('cause scoring: covers, exact and false positives in controls', () => {
  assert.equal(covers('src/a.js:10–14', 'src/a.js:12'), true);
  assert.equal(covers('src/a.js:10', 'src/a.js:12'), false);
  assert.equal(covers('src/b.js', 'src/b.js:3'), true);
  const s = { control: false, culprits: { 'cart total': ['src/cart.js:4'] } };
  const ok = judge({ test_id: 'node:::cart total', confidence: 'confirmed', locations: ['src/cart.js:4'] }, s);
  assert.deepEqual([ok.correct, ok.exact], [true, true]);
  const wide = judge({ test_id: 'node:::cart total', confidence: 'confirmed', locations: ['src/cart.js:2–6'] }, s);
  assert.deepEqual([wide.correct, wide.exact], [true, false]);
  assert.equal(judge({ test_id: 'node:::cart total', confidence: 'confirmed', locations: ['src/cart.js:4', 'src/x.js:1'] }, s).correct, false);
  assert.equal(judge({ test_id: 'node:::flaky', confidence: 'confirmed', locations: ['src/a.js:1'] }, { control: true, culprits: {} }).correct, false);
  const sum = summarize([{ control: false, culprits: s.culprits, findings: [{ ...ok }] }, { control: true, culprits: {}, findings: [] }]);
  assert.deepEqual([sum.precision, sum.recall, sum.false_positives_in_controls], [1, 1, 0]);
});

test('the launch gate: paired bootstrap, refusal review and latency budgets', () => {
  const ci = bootstrap([5, 6, 7, 5, 6, 7, 5, 6]);
  assert.ok(ci.lo > 0 && ci.hi < 8);
  const row = (arm, task, success, tokens) => ({ arm, task, run: 1, success, tokens_to_green: tokens, ms_to_green: tokens, attempts_to_green: 1, refusals: [], findings: [] });
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push(row('plain', `t${i}`, true, 1000), row('skill', `t${i}`, true, 900 + i), row('v2', `t${i}`, true, 600 + i));
  rows.push({ ...row('v2', 'r', true, 1), refusals: [{ reason: 'identical_retry', correct: true }] });
  const latency = { cases: { query: { p95_ms: 50 }, check: { p95_ms: 100 }, 'check-after-failure': { p95_ms: 110 }, blocked: { p95_ms: 55 }, post: { p95_ms: 120 }, statusline: { p95_ms: 45 } } };
  const a = analyze(rows, { cause: { confirmed_findings: 20, correct_findings: 20 }, latency });
  assert.deepEqual(a.launch_gate, { success_within_1_point: true, beats_skill: true, zero_incorrect_refusals: true, cause_precision_95: true, hook_latency_within_budget: true, pass: true });
  const bad = analyze([...rows, { ...row('v2', 'z', true, 1), refusals: [{ reason: 'cached', correct: false }] }], { cause: { confirmed_findings: 20, correct_findings: 18 }, latency: { cases: { query: { p95_ms: 80 } } } });
  assert.deepEqual([bad.launch_gate.zero_incorrect_refusals, bad.launch_gate.cause_precision_95, bad.launch_gate.hook_latency_within_budget, bad.launch_gate.pass], [false, false, false, false]);
});

test('the egress proxy answers blocked hosts with 403 and intercepts TLS with its own CA', async () => {
  const caDir = tmpDir('kerb-ca-');
  const p = spawn(process.execPath, [path.join(ROOT, 'bench/proxy.js'), '--port', '18899', '--allow', 'localhost,127.0.0.1', '--intercept', '*.corp.test', '--ca-dir', caDir], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  try {
    await waitFor(() => out.includes('egress proxy'), 15_000);
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: 18899, path: 'http://registry.npmjs.org/left-pad' }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, b }));
      });
    });
    assert.equal(body.status, 403);
    assert.equal(body.b, 'blocked by policy: registry.npmjs.org\n');
    const curl = (extra) => spawnSync('curl', ['-sS', '-x', 'http://127.0.0.1:18899', ...extra, 'https://api.corp.test/data.json'], { encoding: 'utf8' });
    assert.notEqual(curl([]).status, 0, 'without the CA, verification fails');
    assert.match(curl(['--cacert', path.join(caDir, 'ca.pem')]).stdout, /"ok":true/);
  } finally {
    p.kill();
  }
});

test('bench/arms/skill-only.md is a valid skill with no Kerb commands', () => {
  const s = fs.readFileSync(path.join(ROOT, 'bench/arms/skill-only.md'), 'utf8');
  assert.equal(s.split('\n')[0], '---');
  assert.match(s, /^name: working-rules$/m);
  assert.doesNotMatch(s.replace(/^.*benchmark arm 2.*$/m, ''), /`kerb /, 'arm 2 has no Kerb');
  void os;
});
