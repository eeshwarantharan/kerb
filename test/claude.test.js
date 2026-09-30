import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { makeRepo, records, ROOT, tmpDir, runKerbAsync } from './helpers.js';
import { setHookDelayForTests, denyOnly } from '../src/cli/hook.js';
import { setHashDelayForTests } from '../src/loop/workspace.js';
import { setManagedConfigPathForTests } from '../src/config.js';
import { signBundle } from '../src/bound/org.js';

const FIX = path.join(ROOT, 'test/fixtures/hooks/claude');
const outputs = [];

function payload(name, repo, over = {}) {
  const p = JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
  p.cwd = repo.dir;
  const merged = { ...p, ...over };
  if (over.tool_input) merged.tool_input = { ...p.tool_input, ...over.tool_input };
  return merged;
}
function hook(repo, event, p) {
  const r = repo.kerb(['hook', 'claude', event], { input: JSON.stringify(p) });
  outputs.push(r.stdout);
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* */ }
  return { ...r, json };
}
const pre = (repo, command, id = 't1', extra = {}) => hook(repo, 'pre', payload('pre-bash', repo, { tool_use_id: id, tool_input: { command, ...extra } }));
const post = (repo, command, id, output = 'ok') => hook(repo, 'post', payload('post-bash', repo, { tool_use_id: id, tool_input: { command }, tool_response: { stdout: output, stderr: '', interrupted: false, isImage: false } }));
const fail = (repo, command, id, code = 1, out = 'FAIL: expected 1') => hook(repo, 'post-failure', payload('post-failure-bash', repo, { tool_use_id: id, tool_input: { command }, error: `Exit code ${code}\n${out}` }));

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker', why: 'no docker here' }] }) };

test('K1 pre with a blocked command → deny with the refusal text', () => {
  const repo = makeRepo({ files: POLICY });
  const r = pre(repo, 'docker ps');
  assert.equal(r.code, 0);
  assert.equal(r.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(r.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /^kerb: policy_blocked · docker is blocked here\n\s+source: repo policy \(kerb\.policy\.json\) · no docker here\n\s+next: /);
  assert.equal(records(repo.dir).find((x) => x.type === 'refusal').tier, 'enforced');
});

test('K2 pre with an allowed command → no decision, pending record written', () => {
  const repo = makeRepo();
  const r = pre(repo, 'npm test', 'tuse-2');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(fs.existsSync(path.join(repo.dir, '.kerb/pending/tuse-2.json')));
});

test('K3 post → start and end records with the exit status from the payload', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' }, config: { hash_budget_ms: 10000 } });
  pre(repo, 'npm test', 'a');
  fail(repo, 'npm test', 'a', 3);
  pre(repo, 'ls', 'b');
  post(repo, 'ls', 'b', 'a.js');
  const recs = records(repo.dir);
  const ends = recs.filter((x) => x.type === 'end');
  assert.equal(ends.length, 2);
  assert.equal(ends[0].exit, 3);
  assert.equal(ends[0].class_result, 'failure');
  assert.ok(ends[0].post_hash, 'check class: post hash computed');
  assert.equal(ends[1].exit, 0);
  const starts = recs.filter((x) => x.type === 'start');
  assert.equal(starts[0].session, 'abc123');
  assert.equal(starts[0].agent, 'claude');
  assert.ok(!fs.existsSync(path.join(repo.dir, '.kerb/pending/a.json')), 'pending consumed');
  // The next identical npm test is refused by the pre hook.
  const again = pre(repo, 'npm test', 'c');
  assert.equal(again.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(again.json.hookSpecificOutput.permissionDecisionReason, /identical_retry/);
});

test('K4 post with no exit status → exit null, never a failure', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  pre(repo, 'npm test', 'a');
  hook(repo, 'post-failure', payload('post-failure-bash', repo, { tool_use_id: 'a', tool_input: { command: 'npm test' }, error: 'Tool crashed' }));
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(end.exit, null);
  assert.equal(pre(repo, 'npm test', 'b').stdout, '', 'not refused');
});

test('K5 a background call gets the pre-check only', () => {
  const repo = makeRepo({ files: POLICY });
  assert.equal(pre(repo, 'docker compose up', 'bg1', { run_in_background: true }).json.hookSpecificOutput.permissionDecision, 'deny');
  const r = pre(repo, 'npm run dev', 'bg2', { run_in_background: true });
  assert.equal(r.stdout, '');
  const pend = JSON.parse(fs.readFileSync(path.join(repo.dir, '.kerb/pending/bg2.json'), 'utf8'));
  assert.equal(pend.class, 'background');
  assert.equal(pend.pre_hash, null);
  post(repo, 'npm run dev', 'bg2', '');
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(end.class, 'background');
});

test('K6 an internal error → allow, error logged, counter incremented', () => {
  const repo = makeRepo();
  const r = repo.kerb(['hook', 'claude', 'pre'], { input: '{not json' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.match(fs.readFileSync(path.join(repo.home, '.kerb/errors.log'), 'utf8'), /hook claude pre/);
  const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.kerb/summary.json'), 'utf8'));
  assert.equal(summary.errors, 1);
});

test('K7 a handler that exceeds 1 s → allow', async () => {
  const repo = makeRepo({ files: POLICY });
  setHookDelayForTests(1500);
  try {
    const t0 = Date.now();
    const { main } = await import('../src/cli/main.js');
    let out = '';
    const oldHome = process.env.HOME;
    process.env.HOME = repo.home;
    try {
      const code = await main(['hook', 'claude', 'pre'], { stdin: JSON.stringify(payload('pre-bash', repo, { tool_input: { command: 'docker ps' } })), stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, cwd: repo.dir });
      assert.equal(code, 0);
    } finally {
      process.env.HOME = oldHome;
    }
    assert.equal(out, '', 'no deny after the deadline');
    assert.ok(Date.now() - t0 < 1400);
  } finally {
    setHookDelayForTests(0);
  }
});

test('K8 handlers never emit an allow or approve decision', () => {
  for (const o of outputs) {
    assert.ok(!/"permissionDecision":"(allow|approve|ask|defer)"/.test(o), o);
    assert.ok(!/updatedInput/.test(o), o);
  }
  assert.deepEqual(denyOnly({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'x' } } }), { hookSpecificOutput: { hookEventName: 'PreToolUse' } });
  assert.deepEqual(denyOnly({ decision: 'approve', systemMessage: 'x' }), { systemMessage: 'x' });
  assert.equal(denyOnly({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('K9 the stop hook prints a recap only when there were saves, headed with the tier', () => {
  const repo = makeRepo({ files: POLICY });
  const quiet = hook(repo, 'stop', payload('stop', repo));
  assert.equal(quiet.stdout, '');
  pre(repo, 'docker ps', 'x1');
  const r = hook(repo, 'stop', payload('stop', repo));
  assert.match(r.json.systemMessage, /^kerb recap · this session \(enforced via Claude Code hooks\)/);
  assert.match(r.json.systemMessage, /blocked early\s+1 command refused before running/);
  assert.equal(hook(repo, 'stop', payload('stop', repo)).stdout, '', 'not repeated without new saves');
});

test('K10 session start refreshes the bundle and the briefing', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
  const bundle = JSON.stringify(signBundle({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp', why: 'Use the mirror.' }] }, privateKey.export({ type: 'pkcs8', format: 'pem' }), 9));
  const server = http.createServer((req, res) => res.end(bundle));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const managed = path.join(tmpDir(), 'managed.json');
  fs.writeFileSync(managed, JSON.stringify({ org: { bundle_url: `http://127.0.0.1:${server.address().port}/b.json`, public_key: pub } }));
  setManagedConfigPathForTests(managed);
  try {
    const repo = makeRepo({ files: { 'AGENTS.md': '# Agents\n\n<!-- kerb:start -->\nold\n<!-- kerb:end -->\n' } });
    const { main } = await import('../src/cli/main.js');
    let out = '';
    const oldHome = process.env.HOME;
    process.env.HOME = repo.home;
    try {
      await main(['hook', 'claude', 'start'], { stdin: JSON.stringify(payload('session-start', repo)), stdout: { write: (s) => { out += s; } }, stderr: { write() {} }, cwd: repo.dir });
    } finally {
      process.env.HOME = oldHome;
    }
    const agents = repo.read('AGENTS.md');
    assert.match(agents, /- registry\.npmjs\.org: Use the mirror \(use https:\/\/npm\.corp\)/);
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /Known boundaries:\n- registry\.npmjs\.org/);
  } finally {
    setManagedConfigPathForTests(null);
    server.close();
  }
});

test('K11 the pre handler runs under 100 ms warm on the 5,000-file fixture', async () => {
  const files = { 'package.json': '{}' };
  for (let i = 0; i < 5000; i++) files[`src/d${i % 50}/f${i}.js`] = `${i}\n`;
  const repo = makeRepo({ git: true, files });
  const { main } = await import('../src/cli/main.js');
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  const times = [];
  try {
    for (let i = 0; i < 6; i++) {
      const stdin = JSON.stringify(payload('pre-bash', repo, { tool_use_id: `k11-${i}`, tool_input: { command: 'npm test' } }));
      const t0 = process.hrtime.bigint();
      await main(['hook', 'claude', 'pre'], { stdin, stdout: { write() {} }, stderr: { write() {} }, cwd: repo.dir });
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally {
    process.env.HOME = oldHome;
  }
  const warm = Math.min(...times.slice(1));
  const limit = process.env.CI ? 300 : 100;
  assert.ok(warm < limit, `warm pre took ${warm.toFixed(1)}ms (all ${times.map((t) => t.toFixed(0)).join(', ')})`);
});

test('K12 rewrite mode is off by default and never rewrites Claude Code input', () => {
  const repo = makeRepo();
  assert.equal(pre(repo, 'npm test', 'r1').stdout, '');
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ 'claude.rewrite': true }));
  const r = pre(repo, 'npm test', 'r2');
  assert.ok(!/updatedInput/.test(r.stdout));
  const d = repo.kerb(['doctor', '--json']);
  assert.ok(d.json.checks.some((c) => /claude\.rewrite is set/.test(c.text)));
});

test('K13 hash budget exceeded in pre → allowed, skip recorded', async () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  pre(repo, 'npm test', 'h1');
  fail(repo, 'npm test', 'h1');
  setHashDelayForTests(400);
  try {
    const { main } = await import('../src/cli/main.js');
    let s = '';
    const oldHome = process.env.HOME;
    process.env.HOME = repo.home;
    try {
      await main(['hook', 'claude', 'pre'], { stdin: JSON.stringify(payload('pre-bash', repo, { tool_use_id: 'h2', tool_input: { command: 'npm test' } })), stdout: { write: (x) => { s += x; } }, stderr: { write() {} }, cwd: repo.dir });
    } finally {
      process.env.HOME = oldHome;
    }
    assert.equal(s, '', 'allowed despite the identical retry');
  } finally {
    setHashDelayForTests(0);
  }
  fail(repo, 'npm test', 'h2');
  const ends = records(repo.dir).filter((x) => x.type === 'end');
  assert.equal(ends.at(-1).loop_skipped, 'hash_budget');
});

test('K14 / WF8 the agent Bash timeout from the payload caps kerb run and kerb wait-for', async () => {
  const repo = makeRepo();
  pre(repo, 'kerb run -- sleep 30', 'k14a', { timeout: 12_000 });
  const t0 = Date.now();
  const { done } = runKerbAsync(['run', '--', 'sleep 30'], { cwd: repo.dir, env: repo.env });
  const r = await done;
  assert.equal(r.code, 124, r.stderr);
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
  const start = records(repo.dir).find((x) => x.type === 'start');
  assert.equal(start.tier, 'enforced');
  assert.equal(start.session, 'abc123');
  pre(repo, 'kerb wait-for --max 3m -- exit 1', 'k14b', { timeout: 13_000 });
  const w = runKerbAsync(['wait-for', '--interval', '1s', '--max', '3m', '--', 'exit 1'], { cwd: repo.dir, env: repo.env });
  const wr = await w.done;
  assert.equal(wr.code, 124);
  assert.match(wr.stderr, /--max capped at 3s/);
  // The hook itself records nothing for kerb invocations (kerb run records its own run).
  fail(repo, 'kerb run -- sleep 30', 'k14a', 124);
  assert.equal(records(repo.dir).filter((x) => x.type === 'end').length, 1);
});
