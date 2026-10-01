// SH · Shadow mode (KERB-V2 10.2, tests SH1–SH8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, inproc, shPath } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { setManagedConfigPathForTests } from '../src/config.js';
import { main } from '../src/cli/main.js';
import { shadowPromptDue, SHADOW_PROMPT_EVENTS } from '../src/mode.js';

const DAY = 86_400_000;
const POLICY = {
  'kerb.policy.json': JSON.stringify({
    boundaries: [{ kind: 'host', pattern: 'blocked.example', why: 'blocked here' }],
    fixes: [{ output_contains: 'ECONNREFUSED 127.0.0.1:5432', hint: 'Start the database first: make db-up' }],
  }),
  'a.js': '1\n',
};

const base = (repo, id, command) => ({ session_id: 's1', transcript_path: '/t', cwd: repo.dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
function hook(repo, event, p, opts = {}) {
  const r = repo.kerb(['hook', 'claude', event], { input: JSON.stringify(p), ...opts });
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* */ }
  return { ...r, json };
}
const pre = (repo, id, command) => hook(repo, 'pre', base(repo, id, command));
const fail = (repo, id, command, out = 'FAIL: expected 1') => hook(repo, 'post-failure', { ...base(repo, id, command), hook_event_name: 'PostToolUseFailure', error: `Exit code 1\n${out}` });
const stop = (repo) => hook(repo, 'stop', { session_id: 's1', transcript_path: '/t', cwd: repo.dir, hook_event_name: 'Stop' });

function shadowRepo(extra = {}) {
  const repo = makeRepo({ git: true, files: POLICY, ...extra });
  assert.equal(repo.kerb(['init', '--agent', 'claude']).code, 0);
  return repo;
}

test('SH1 init sets shadow with an expiry 7 days out', () => {
  const before = Date.now();
  const repo = shadowRepo();
  const m = JSON.parse(repo.read('.kerb/mode.json'));
  assert.equal(m.mode, 'shadow');
  assert.ok(m.since >= before && m.since <= Date.now());
  assert.equal(m.until - m.since, 7 * DAY);
  const j = repo.kerb(['mode', '--json']).json;
  assert.equal(j.mode, 'shadow');
  assert.equal(j.days_left, 7);
  assert.match(repo.kerb(['init', '--agent', 'claude']).stdout, /mode: shadow until \d{4}-\d{2}-\d{2}/);
  // Running init again keeps the original clock.
  assert.deepEqual(JSON.parse(repo.read('.kerb/mode.json')), m);
  // A dry run writes nothing.
  const dry = makeRepo({ git: true });
  dry.kerb(['init', '--agent', 'claude', '--dry-run']);
  assert.equal(dry.exists('.kerb/mode.json'), false);
});

test('SH2 in shadow, a blocked host is not denied; a would_refuse event is recorded', () => {
  const repo = shadowRepo();
  const r = pre(repo, 'c1', 'curl https://blocked.example/x');
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '', 'no deny, nothing injected');
  const recs = records(repo.dir);
  assert.equal(recs.filter((x) => x.type === 'refusal').length, 0);
  const w = recs.find((x) => x.type === 'would_refuse');
  assert.equal(w.reason, 'policy_blocked');
  assert.match(w.summary, /blocked\.example/);
  // kerb run and kerb wait-for run the command anyway, silently.
  const ran = shPath(repo.home, 'ran');
  const run = repo.kerb(['run', '--', `curl https://blocked.example/x >/dev/null 2>&1; echo yes > ${ran}; true`]);
  assert.equal(run.code, 0);
  assert.doesNotMatch(run.stderr, /policy_blocked/);
  assert.ok(fs.existsSync(ran), 'the command ran');
  // kerb check says it would run (exit 0) and names what enforce mode would do.
  const chk = repo.kerb(['check', '--json', '--', 'curl https://blocked.example/x']);
  assert.equal(chk.code, 0);
  assert.equal(chk.json.refused, false);
  assert.equal(chk.json.would_refuse.reason, 'policy_blocked');
});

test('SH2 a loop refusal in shadow lets the retry run and records would_refuse', () => {
  const repo = shadowRepo({ config: { hash_budget_ms: 10_000 } });
  pre(repo, 'a', 'npm test');
  fail(repo, 'a', 'npm test');
  const again = pre(repo, 'b', 'npm test');
  assert.equal(again.stdout, '');
  assert.ok(repo.exists('.kerb/pending/b.json'), 'the retry goes ahead as an observed call');
  const w = records(repo.dir).find((x) => x.type === 'would_refuse');
  assert.equal(w.reason, 'identical_retry');
  assert.ok(w.matched_run);
});

test('SH3 the recap shows would-have counts', () => {
  const repo = shadowRepo({ config: { hash_budget_ms: 10_000 } });
  pre(repo, 'a', 'npm test');
  fail(repo, 'a', 'npm test');
  pre(repo, 'b', 'npm test');
  fail(repo, 'b', 'npm test');
  pre(repo, 'c', 'curl https://blocked.example/x');
  const s = stop(repo);
  assert.match(s.json.systemMessage, /would have stopped\s+1 re-run and 1 blocked retry \(shadow mode; nothing was blocked\)/);
  assert.match(s.json.systemMessage, /shadow mode\)/);
  assert.match(repo.kerb(['statusline']).stdout, /^kerb · shadow: would have stopped 2/);
  const rep = repo.kerb(['report', '--json']).json.measured;
  assert.equal(rep.would_refuse, 2);
});

test('SH4 insights still inject in shadow; insights off turns them off', () => {
  const repo = shadowRepo();
  pre(repo, 'a', 'npm test');
  const r = fail(repo, 'a', 'npm test', 'Error: connect ECONNREFUSED 127.0.0.1:5432');
  assert.match(r.json.hookSpecificOutput.additionalContext, /kerb: hint · Start the database first: make db-up/);
  const off = shadowRepo({ config: { insights: 'off' } });
  pre(off, 'a', 'npm test');
  assert.equal(fail(off, 'a', 'npm test', 'Error: connect ECONNREFUSED 127.0.0.1:5432').stdout, '');
});

test('SH5 enforce is human-only', async () => {
  // In enforce mode the hook refuses an agent's `kerb enforce`.
  const plain = makeRepo({ git: true });
  const h = pre(plain, 'e', 'kerb enforce');
  assert.equal(h.json.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(h.json.hookSpecificOutput.permissionDecisionReason, /human_only · kerb enforce is for the user/);
  // Without a terminal, enforce exits 64 and the mode stays shadow.
  const repo = shadowRepo();
  const r = repo.kerb(['enforce'], { input: '' });
  assert.equal(r.code, 64);
  assert.match(r.stderr, /human_only/);
  assert.equal(JSON.parse(repo.read('.kerb/mode.json')).mode, 'shadow');
  // With the human's code, blocking turns on.
  setHumanOverrideForTests(() => true);
  try { assert.equal((await inproc(repo, ['enforce'])).code, 0); } finally { setHumanOverrideForTests(null); }
  assert.equal(JSON.parse(repo.read('.kerb/mode.json')).mode, 'enforce');
  const d = pre(repo, 'c', 'curl https://blocked.example/x');
  assert.equal(d.json.hookSpecificOutput.permissionDecision, 'deny');
});

test('SH6 after expiry the recap prompts once; mode stays shadow until a human acts', () => {
  const repo = shadowRepo();
  const now = Date.now();
  fs.writeFileSync(path.join(repo.dir, '.kerb/mode.json'), JSON.stringify({ mode: 'shadow', since: now - 8 * DAY, until: now - DAY, set_by: 'init' }));
  pre(repo, 'c', 'curl https://blocked.example/x');
  const first = stop(repo);
  assert.match(first.json.systemMessage, /kerb: shadow · shadow mode has run for 7 days; Kerb would have stopped 1 command/);
  assert.match(first.json.systemMessage, /kerb review-shadow/);
  assert.match(first.json.systemMessage, /kerb enforce/);
  assert.equal(stop(repo).stdout, '', 'shown once');
  assert.equal(repo.kerb(['mode', '--json']).json.mode, 'shadow');
  assert.equal(repo.kerb(['mode', '--json']).json.expired, true);
  // The 20-event threshold triggers it before day 7.
  const live = { mode: 'shadow', source: 'repo', expired: false, prompted_at: null };
  assert.equal(shadowPromptDue(live, SHADOW_PROMPT_EVENTS - 1), false);
  assert.equal(shadowPromptDue(live, SHADOW_PROMPT_EVENTS), true);
});

test('SH7 managed mode enforce skips shadow', async () => {
  const repo = makeRepo({ git: true, files: POLICY });
  const managed = path.join(repo.home, 'managed.json');
  fs.writeFileSync(managed, JSON.stringify({ mode: 'enforce' }));
  setManagedConfigPathForTests(managed);
  try {
    const r = await inproc(repo, ['init', '--agent', 'claude', '--json']);
    assert.equal(r.json.mode.mode, 'enforce');
    assert.equal(r.json.mode.source, 'managed');
    assert.equal(repo.exists('.kerb/mode.json'), false);
    let out = '';
    const io = { stdout: { write(s) { out += s; return true; }, isTTY: false }, stderr: { write() { return true; }, isTTY: false }, cwd: repo.dir, env: repo.env };
    const oldHome = process.env.HOME;
    process.env.HOME = repo.home;
    try {
      await main(['hook', 'claude', 'pre'], { ...io, stdin: JSON.stringify(base(repo, 'm1', 'curl https://blocked.example/x')) });
    } finally { process.env.HOME = oldHome; }
    assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, 'deny');
    // The user can't switch it back to shadow either.
    assert.equal((await inproc(repo, ['enforce'])).code, 64);
  } finally {
    setManagedConfigPathForTests(null);
  }
});

test('SH8 review-shadow lists each event with evidence and what happened next', () => {
  const repo = shadowRepo({ config: { hash_budget_ms: 10_000 } });
  pre(repo, 'a', 'npm test');
  fail(repo, 'a', 'npm test', 'FAIL cart.test.js: expected 90, got 100');
  pre(repo, 'b', 'npm test');
  fail(repo, 'b', 'npm test', 'FAIL cart.test.js: expected 90, got 100');
  pre(repo, 'c', 'curl https://blocked.example/x');
  const j = repo.kerb(['review-shadow', '--json']).json;
  assert.equal(j.total, 2);
  const loop = j.events.find((e) => e.reason === 'identical_retry');
  assert.match(loop.evidence, /matches run \S+ \(ordinary\) · FAIL cart\.test\.js/);
  assert.equal(loop.outcome.verdict, 'same_result');
  const text = repo.kerb(['review-shadow']).stdout;
  assert.match(text, /2 commands Kerb would have stopped/);
  assert.match(text, /identical_retry {2}npm test/);
  assert.match(text, /then: ran anyway: exit 1, the same failure as before/);
  assert.match(text, /policy_blocked {2}curl https:\/\/blocked\.example\/x/);
  assert.match(text, /kerb enforce/);
});
