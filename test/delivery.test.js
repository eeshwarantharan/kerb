// VS · Verification status and stop gate, DV · Delivery (KERB-V2 7.2, 9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ROOT } from './helpers.js';
import { Store } from '../src/store/jsonl.js';
import { sessionStartText } from '../src/insight/deliver.js';
import { mergeLayers } from '../src/bound/policy.js';

const FIX = path.join(ROOT, 'test/fixtures/hooks');
const payload = (agent, name, repo, over = {}) => ({ ...JSON.parse(fs.readFileSync(path.join(FIX, agent, `${name}.json`), 'utf8')), cwd: repo.dir, ...over });

function pytestText({ pass = [], fail = [] }) {
  const lines = ['============================= test session starts ==============================', ''];
  for (const t of pass) lines.push(`tests/test_cart.py::${t} PASSED`);
  for (const t of fail) lines.push(`tests/test_cart.py::${t} FAILED`);
  lines.push(`========================= ${[fail.length && `${fail.length} failed`, pass.length && `${pass.length} passed`].filter(Boolean).join(', ')} in 0.01s =========================`);
  return lines.join('\n');
}

function claude(repo, { session = 's1' } = {}) {
  let n = 0;
  const hook = (event, p) => {
    const r = repo.kerb(['hook', 'claude', event], { input: JSON.stringify(p) });
    assert.equal(r.code, 0);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  const base = (command, id) => ({ session_id: session, transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  return {
    hook,
    /** Run a check through the hooks with the given result. */
    check(res, command = 'pytest -v') {
      const id = `t${++n}`;
      hook('pre', base(command, id));
      if (res.fail && res.fail.length) return hook('post-failure', { ...base(command, id), error: `Exit code 1\n${pytestText(res)}` });
      return hook('post', { ...base(command, id), tool_response: { stdout: pytestText(res), stderr: '', interrupted: false } });
    },
    stop(over = {}) { return hook('stop', { session_id: session, transcript_path: '/t', cwd: repo.dir, hook_event_name: 'Stop', stop_hook_active: false, ...over }); },
    start(source) { return hook('start', { session_id: session, transcript_path: '/t', cwd: repo.dir, hook_event_name: 'SessionStart', source }); },
  };
}

const status = (repo) => repo.kerb(['status', '--json']).json.verification;

test('VS1 green, red, stale and never; VS2 stale lists the changed files', () => {
  const repo = makeRepo({ git: true, files: { 'src/cart.py': 'v = 1\n', 'kerb.policy.json': JSON.stringify({ verify_keys: ['npm run lint'] }) } });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  const [red] = status(repo).filter((v) => v.command === 'pytest -v');
  assert.equal(red.status, 'red');
  repo.write('src/cart.py', 'v = 2\n');
  const stale = status(repo).find((v) => v.command === 'pytest -v');
  assert.equal(stale.status, 'stale');
  assert.deepEqual(stale.files, ['src/cart.py']);
  c.check({ pass: ['test_a'] });
  assert.equal(status(repo).find((v) => v.command === 'pytest -v').status, 'green');
  assert.equal(status(repo).find((v) => v.command === 'npm run lint').status, 'never');
  assert.match(repo.kerb(['status']).stdout, /^verification\n {2}pytest -v {2}green/m);
});

test('VS3 the status line shows the verification Stop found; VS4 warn adds it to the recap', () => {
  const repo = makeRepo({ git: true, files: { 'src/cart.py': 'v = 1\n', 'src/pricing.py': 'p = 1\n' } });
  const c = claude(repo);
  c.check({ pass: ['test_a'] });
  assert.match(repo.kerb(['statusline']).stdout, /^kerb · tests: green/);
  repo.write('src/pricing.py', 'p = 2\n');
  const out = c.stop();
  assert.match(out.systemMessage, /kerb: verification · pytest -v is stale: last green before you edited pricing\.py/);
  assert.match(repo.kerb(['statusline']).stdout, /^kerb · tests: stale \(pricing\.py\)/);
  assert.equal(c.stop(), null, 'said once per state');
});

test('VS5 stop_gate "block" blocks once, then yields', () => {
  const repo = makeRepo({ git: true, files: { 'src/cart.py': 'v = 1\n', 'kerb.policy.json': JSON.stringify({ stop_gate: 'block' }) } });
  const c = claude(repo);
  c.check({ pass: ['test_a'] });
  repo.write('src/cart.py', 'v = 2\n');
  const first = c.stop();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /pytest -v is stale: last green before you edited cart\.py\nkerb: verification · run the tests again before you finish/);
  assert.equal(c.stop(), null, 'the same state: yield');
  repo.write('src/cart.py', 'v = 3\n');
  assert.notEqual((c.stop({ stop_hook_active: true }) || {}).decision, 'block', 'never while Claude is already continuing for a Stop hook');
});

test('VS6 stop_gate "off" says nothing', () => {
  const repo = makeRepo({ git: true, files: { 'src/cart.py': 'v = 1\n', 'kerb.policy.json': JSON.stringify({ stop_gate: 'off' }) } });
  const c = claude(repo);
  c.check({ pass: ['test_a'] });
  repo.write('src/cart.py', 'v = 2\n');
  assert.equal(c.stop(), null);
});

test('VS7 MCP verification_status matches the CLI', { todo: 'the MCP server arrives in milestone F (F2)' }, () => {});

test('VS8 policy verify_keys are tracked even before they run', () => {
  const repo = makeRepo({ git: true, files: { 'kerb.policy.json': JSON.stringify({ verify_keys: ['npm run lint', '.::make check'] }) } });
  const keys = status(repo).map((v) => [v.key, v.status]);
  assert.deepEqual(keys, [['.::npm run lint', 'never'], ['.::make check', 'never']]);
});

test('DV1 one injection per moment: delta, environment fix and hint in one block', () => {
  const repo = makeRepo({ git: true, files: { 'kerb.policy.json': JSON.stringify({ fixes: [{ output_contains: 'certificate verify failed', hint: 'see the TLS page in the wiki' }] }) } });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  const p = { session_id: 's1', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'pytest -v' }, tool_use_id: 'env1' };
  repo.write('x.py', '1\n');
  c.hook('pre', p);
  const out = c.hook('post-failure', { ...p, error: `Exit code 1\n${pytestText({ fail: ['test_a', 'test_b'] })}\nSSL: CERTIFICATE_VERIFY_FAILED certificate verify failed` });
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^kerb: pytest -v · 2 failing \(was 1\)/);
  assert.match(text, /\nkerb: environment · TLS interception/);
  assert.match(text, /\nkerb: hint · see the TLS page in the wiki/);
});

test('DV2 size limits: 10 lines after a command, 400/300 tokens at session start, 8 lines at stop', () => {
  const boundaries = Array.from({ length: 40 }, (_, i) => ({ kind: 'host', pattern: `blocked-${i}.example.com`, why: 'a long reason for this boundary, to fill the briefing' }));
  const repo = makeRepo({ git: true, files: { 'kerb.policy.json': JSON.stringify({ boundaries }) } });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  repo.write('y.py', '1\n');
  const many = Array.from({ length: 30 }, (_, i) => `test_${i}`);
  const after = c.check({ fail: many }).hookSpecificOutput.additionalContext;
  assert.ok(after.split('\n').length <= 10, after);
  const store = new Store(repo.dir);
  const common = { root: repo.dir, git: true, store, policy: mergeLayers([{ name: 'repo', policy: { boundaries }, source: 'repo' }]), env: {}, nowTs: Date.now(), session: 's1', briefing: boundaries.map((b) => `- ${b.pattern}: ${b.why}`) };
  assert.ok(Buffer.byteLength(sessionStartText({ ...common, after: false })) <= 1600);
  assert.ok(Buffer.byteLength(sessionStartText({ ...common, after: true })) <= 1200);
  repo.write('y.py', '2\n');
  const stop = c.stop();
  assert.ok(!stop || stop.systemMessage.split('\n').length <= 8);
});

test('DV3 nothing after small successful commands; DV4 every block starts with kerb', () => {
  const repo = makeRepo({ git: true });
  const c = claude(repo);
  const p = { session_id: 's1', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'e1' };
  c.hook('pre', p);
  assert.equal(c.hook('post', { ...p, tool_response: { stdout: 'hi', stderr: '', interrupted: false } }), null);
  c.check({ fail: ['test_a'] });
  const blocks = [c.start('startup'), c.start('compact')].filter(Boolean).map((o) => o.hookSpecificOutput.additionalContext);
  assert.ok(blocks.length);
  for (const b of blocks) assert.match(b, /^kerb(:| ledger)/, b);
});

test('DV5 each agent gets the ledger where it can; DV8 per-agent payload fixtures', () => {
  const repo = makeRepo({ git: true });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  repo.write('src/a.py', '1\n');
  c.check({ fail: ['test_a'] });
  const run = (agent, event, name, over) => {
    const r = repo.kerb(['hook', agent, event], { input: JSON.stringify(payload(agent, name, repo, over)) });
    assert.equal(r.code, 0, `${agent} ${event}`);
    return r.stdout.trim() ? JSON.parse(r.stdout) : null;
  };
  // Claude and Codex: SessionStart with source "compact" or "resume" carries the ledger.
  for (const [agent, name] of [['claude', 'session-start-compact'], ['claude', 'session-start-resume'], ['codex', 'session-start-compact']]) {
    assert.match(run(agent, 'start', name).hookSpecificOutput.additionalContext, /^kerb ledger · /, `${agent} ${name}`);
  }
  // Gemini: PreCompress only observes; the ledger arrives once with the next BeforeAgent.
  assert.equal(run('gemini', 'compact', 'pre-compress'), null);
  assert.match(run('gemini', 'turn', 'before-agent').hookSpecificOutput.additionalContext, /^kerb ledger · /);
  assert.equal(run('gemini', 'turn', 'before-agent'), null, 'once');
  assert.match(run('gemini', 'start', 'session-start-resume').hookSpecificOutput.additionalContext, /^kerb ledger · /);
  // Copilot (sessionStart source "resume"), Cursor (sessionStart), OpenCode (compaction prompt).
  assert.match(run('copilot', 'start', 'session-start-resume').additionalContext, /^kerb ledger · /);
  assert.match(run('cursor', 'start', 'session-start').additional_context, /kerb ledger · /);
  assert.match(run('opencode', 'compact', 'compacting').context, /^kerb ledger · /);
  // Stop gates where the agent can continue (Codex, Copilot), recap only elsewhere.
  const policy = path.join(repo.dir, 'kerb.policy.json');
  fs.writeFileSync(policy, JSON.stringify({ stop_gate: 'block' }));
  c.check({ pass: ['test_a'] });
  repo.write('src/a.py', '2\n');
  assert.equal(run('codex', 'stop', 'stop', { session_id: 's1' }).decision, 'block');
  repo.write('src/a.py', '3\n');
  assert.equal(run('copilot', 'stop', 'agent-stop', { sessionId: 's1' }).decision, 'block');
  for (const a of ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'opencode']) {
    assert.ok(fs.readdirSync(path.join(FIX, a)).some((f) => /start|compact|stop|before-agent/.test(f)), `${a} has delivery fixtures`);
  }
});

test('DV6 injections are deterministic for the same records', () => {
  const repo = makeRepo({ git: true });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  repo.write('src/a.py', '1\n');
  c.check({ fail: ['test_a', 'test_b'] });
  const a = c.start('compact').hookSpecificOutput.additionalContext;
  const b = c.start('compact').hookSpecificOutput.additionalContext;
  assert.equal(a, b);
});

test('DV7 injection failures fail open', () => {
  const repo = makeRepo({ git: true });
  const c = claude(repo);
  c.check({ fail: ['test_a'] });
  const log = path.join(repo.dir, '.kerb/runs.jsonl');
  const lines = fs.readFileSync(log, 'utf8').split('\n');
  lines[1] = '{"damaged": true';
  fs.writeFileSync(log, lines.join('\n'));
  for (const [event, p] of [['start', { session_id: 's1', cwd: repo.dir, source: 'compact' }], ['stop', { session_id: 's1', cwd: repo.dir }]]) {
    const r = repo.kerb(['hook', 'claude', event], { input: JSON.stringify(p) });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /decision/);
  }
});
