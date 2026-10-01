import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, runKerbAsync, inproc, shPath } from './helpers.js';
import { setClock } from '../src/util/core.js';
import { evaluateRules } from '../src/loop/rules.js';
import { mergeLayers } from '../src/bound/policy.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { ackKey } from '../src/cli/ack.js';
import { Store } from '../src/store/jsonl.js';

/** A repo plus a check-class failing command whose side effects land outside the repo. */
function setup({ git = true, files = {} } = {}) {
  const repo = makeRepo({ git, files: { 'a.js': '1\n', ...files } });
  const ran = shPath(repo.home, 'ran.log');
  const count = () => (fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').split('\n').filter(Boolean).length : 0);
  const cmd = (body = 'echo "FAIL: expected 1 to equal 2"; exit 1') => `echo x >> ${ran}; ${body}`;
  const check = (body, extra = []) => repo.kerb(['run', '--class', 'check', ...extra, '--', cmd(body)]);
  return { repo, ran, count, cmd, check };
}

test('L1 an ordinary failure rerun with nothing changed → identical_retry; not executed', () => {
  const { check, count } = setup();
  assert.equal(check().code, 1);
  const r = check();
  assert.equal(r.code, 75);
  assert.match(r.stderr, /^kerb: identical_retry · /m);
  assert.match(r.stderr, /next: change something first, or run `kerb diff`/);
  assert.equal(count(), 1);
});

test('L2 fail → a setup command (other) → rerun is allowed', () => {
  const { repo, check, count } = setup();
  check();
  assert.equal(repo.kerb(['run', '--', 'true']).code, 0);
  assert.equal(check().code, 1);
  assert.equal(count(), 2);
});

test('L3 fail → start a background server → rerun is allowed', () => {
  const { repo, check, count } = setup();
  check();
  assert.equal(repo.kerb(['run', '--', 'sleep 1 &']).code, 0);
  assert.equal(check().code, 1);
  assert.equal(count(), 2);
});

test('L4 fail → a query command → rerun is refused', () => {
  const { repo, check, count } = setup();
  check();
  repo.kerb(['run', '--', 'grep -c 1 a.js']);
  assert.equal(check().code, 75);
  assert.equal(count(), 1);
});

test('L5 a transient failure gets one identical retry; a second transient failure refuses the next', () => {
  const { check, count } = setup();
  const body = 'echo "Error: read ECONNRESET"; exit 1';
  assert.equal(check(body).code, 1);
  assert.equal(check(body).code, 1);
  const r = check(body);
  assert.equal(r.code, 75);
  assert.match(r.stderr, /this failed twice on a flaky dependency; wait or check it before retrying/);
  assert.equal(count(), 2);
});

test('L6 fail → change a dependency marker → rerun allowed (env stamp changed)', () => {
  const { repo, check, count } = setup({ git: false, files: { 'package.json': '{}', 'node_modules/.package-lock.json': '{}' } });
  check();
  const f = path.join(repo.dir, 'node_modules/.package-lock.json');
  fs.writeFileSync(f, '{"lockfileVersion":3}');
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(f, later, later);
  assert.equal(check().code, 1);
  assert.equal(count(), 2);
});

test('L7 fail in S1, edit to S2 and fail, revert to S1 → deja_vu naming the first run', () => {
  const { repo, check, count } = setup();
  check();
  const first = records(repo.dir).find((r) => r.type === 'end').id;
  repo.write('a.js', '2\n');
  check();
  repo.write('a.js', '1\n');
  const r = check();
  assert.equal(r.code, 75);
  assert.match(r.stderr, /^kerb: deja_vu · /m);
  assert.ok(r.stderr.includes(first), 'names the first run');
  assert.match(r.stderr, /2 attempts ago/);
  assert.equal(count(), 2);
});

test('L8 three ordinary failures with the same fingerprint in three states → breaker_open listing changed files', () => {
  const { repo, check, count } = setup();
  for (const v of ['1', '2', '3']) {
    repo.write('a.js', `${v}\n`);
    assert.equal(check().code, 1);
  }
  repo.write('a.js', '4\n');
  const r = check();
  assert.equal(r.code, 75);
  assert.match(r.stderr, /^kerb: breaker_open · /m);
  assert.match(r.stderr, /a\.js/);
  assert.match(r.stderr, /ask the user to run `kerb ack`/);
  assert.equal(count(), 3);
});

test('L9 three failures with the same fingerprint in the same state → identical_retry, not breaker', () => {
  const { repo, check } = setup();
  check();
  repo.kerb(['run', '--', 'true']);
  check();
  repo.kerb(['run', '--', 'true']);
  check();
  const r = check();
  assert.equal(r.code, 75);
  assert.match(r.stderr, /^kerb: identical_retry/m);
});

test('L10 different fingerprints → no breaker', () => {
  const { repo, check, count } = setup();
  for (const v of ['1', '2', '3', '4']) {
    repo.write('a.js', `${v}\n`);
    assert.equal(check(`echo "FAIL: case ${v}"; exit 1`).code, 1);
  }
  assert.equal(count(), 4);
});

test('L11 a success clears the key', () => {
  const { repo, check, count } = setup();
  const body = 'if [ -f ok.flag ]; then echo pass; exit 0; fi; echo FAIL; exit 1';
  check(body);
  repo.write('ok.flag', '');
  assert.equal(check(body).code, 0);
  fs.unlinkSync(path.join(repo.dir, 'ok.flag'));
  assert.equal(check(body).code, 1, 'back in the old failing state, but history was cleared');
  assert.equal(count(), 3);
});

test('L12 keys are independent', () => {
  const { repo, check, count, cmd } = setup();
  check();
  const other = repo.kerb(['run', '--class', 'check', '--', cmd('echo other; exit 1')]);
  assert.equal(other.code, 1, "another key's failure doesn't refuse this one");
  assert.equal(repo.kerb(['run', '--class', 'check', '--', cmd('echo other; exit 1')]).code, 75);
  assert.equal(count(), 2);
});

test('L13 query and other classes are never refused by Loopbreaker', () => {
  const { repo } = setup();
  for (let i = 0; i < 3; i++) assert.equal(repo.kerb(['run', '--', 'grep -q nomatch a.js']).code, 1);
  for (let i = 0; i < 3; i++) assert.notEqual(repo.kerb(['run', '--', 'aws s3 ls definitely-missing-bucket-kerb']).code, 75);
});

function rec(o) {
  const base = { key: 'k', class: 'check', env_stamp: 'E', fingerprint: 'F', failure_kind: 'ordinary', first_fail_line: 'FAIL' };
  const r = { ...base, ...o };
  return [
    { type: 'start', id: r.id, ts: r.ts, key: r.key, class: r.class, pre_hash: r.pre_hash ?? 'H', env_stamp: r.env_stamp },
    { type: 'end', id: r.id, ts: r.end ?? r.ts + 10, exit: 'exit' in o ? o.exit : 1, post_hash: r.post_hash ?? 'H', fingerprint: r.fingerprint, failure_kind: r.failure_kind, class_result: r.class_result ?? 'failure', first_fail_line: r.first_fail_line, duration_ms: 10, shown_bytes: 5 },
  ];
}
const policy = mergeLayers([]);
const evalAt = (recs, nowTs = 1000) => evaluateRules({ recs, key: 'k', hash: 'H', envStamp: 'E', nowTs, policy, command: 'npm test' });

test('L14 a policy-denial run is not a failure', () => {
  assert.equal(evalAt(rec({ id: 'a', ts: 1, class_result: 'policy_denial', failure_kind: null })), null);
  assert.ok(evalAt(rec({ id: 'a', ts: 1 }))); // control: an ordinary failure is refused
});

test('L15 an aborted run is not a failure', () => {
  assert.equal(evalAt(rec({ id: 'a', ts: 1, class_result: 'aborted', exit: 143, failure_kind: null })), null);
  assert.equal(evalAt(rec({ id: 'a', ts: 1, exit: null, class_result: 'failure' })), null, 'unknown exit never counts');
});

test('L16 concurrent runs of the same key both run, with one note line', async () => {
  const { repo, ran, count } = setup();
  const c = `echo x >> ${ran}; sleep 1; exit 1`;
  const a = runKerbAsync(['run', '--class', 'check', '--', c], { cwd: repo.dir, env: repo.env });
  await new Promise((r) => setTimeout(r, 400));
  const b = runKerbAsync(['run', '--class', 'check', '--', c], { cwd: repo.dir, env: repo.env });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.code, 1);
  assert.equal(rb.code, 1);
  assert.equal(count(), 2);
  const notes = `${ra.stderr}${rb.stderr}`.match(/kerb: note · the same command is already running as \S+/g) || [];
  assert.equal(notes.length, 1);
});

test('L17–L19 dependency-unavailable: cooldown refusal, retry after 60 s, cooldown restarts', async () => {
  const { repo, ran, count } = setup();
  const body = `echo x >> ${ran}; echo "Error: connect ECONNREFUSED 127.0.0.1:5432"; exit 1`;
  let t = 1_700_000_000_000;
  setClock(() => t);
  try {
    const run = () => inproc(repo, ['run', '--class', 'check', '--', body]);
    assert.equal((await run()).code, 1);
    t += 10_000;
    const r17 = await run();
    assert.equal(r17.code, 75, 'L17 refused at 10 s');
    assert.match(r17.stderr, /kerb wait-for -- /);
    assert.match(r17.stderr, /retry allowed in 5\d s/);
    t += 51_000;
    assert.equal((await run()).code, 1, 'L18 allowed at 61 s');
    t += 10_000;
    const r19 = await run();
    assert.equal(r19.code, 75, 'L19 cooldown restarted from the allowed retry');
  } finally {
    setClock(null);
  }
  assert.equal(count(), 2);
});

test('L20 transient and dependency failures do not count toward the breaker', () => {
  const { repo, check, count } = setup();
  repo.write('a.js', '1\n'); check();
  repo.write('a.js', '2\n'); check();
  repo.write('a.js', '3\n'); check('echo "socket hang up"; exit 1');
  repo.write('a.js', '4\n');
  assert.equal(check().code, 1, 'only two ordinary failures counted');
  repo.write('a.js', '5\n');
  const r = check();
  assert.equal(r.code, 75, 'third ordinary failure opens it');
  assert.match(r.stderr, /breaker_open/);
  assert.equal(count(), 4);
});

test('L21 deja_vu ignores transient and dependency-unavailable failures', () => {
  const { repo, check, count } = setup();
  check('echo "ETIMEDOUT"; exit 1');
  repo.write('a.js', '2\n');
  check();
  repo.write('a.js', '1\n');
  assert.equal(check().code, 1);
  assert.equal(count(), 3);
});

test('L22 refusal messages differ by failure kind', () => {
  const ord = evalAt(rec({ id: 'a', ts: 1 }));
  const tr = evalAt([...rec({ id: 'a', ts: 1, failure_kind: 'transient' }), ...rec({ id: 'b', ts: 20, failure_kind: 'transient' })]);
  const dep = evalAt(rec({ id: 'a', ts: 1, failure_kind: 'dependency' }), 5000);
  assert.match(ord.refusal.next, /change something first/);
  assert.match(tr.refusal.next, /flaky dependency/);
  assert.match(dep.refusal.next, /start it, or poll with `kerb wait-for -- npm test` \(retry allowed in 56 s\)/);
  assert.equal(new Set([ord.refusal.next, tr.refusal.next, dep.refusal.next]).size, 3);
});

test('C3 loop refusals record avoided duration and bytes of the matched run', () => {
  const { repo, check } = setup();
  check();
  check();
  const recs = records(repo.dir);
  const end = recs.find((r) => r.type === 'end');
  const ref = recs.find((r) => r.type === 'refusal');
  assert.equal(ref.matched_run, end.id);
  assert.equal(ref.avoided_duration_ms, end.duration_ms);
  assert.equal(ref.avoided_output_bytes, end.shown_bytes);
});

// ---------------------------------------------------------------------------
// Human-only (4.7.7)

test('H1–H3 human-only commands are refused before running (shared hook check)', () => {
  const { repo } = setup();
  for (const c of ['kerb ack', 'kerb reset', 'kerb forget x.example', 'kerb config set recap off', 'kerb uninstall',
    'KERB_HUMAN=1 kerb ack', 'env KERB_X=1 npm test', 'script -q /dev/null kerb ack', 'export KERB_EXIT_LOOP=0',
    'kerb run --force -- npm test', 'npx kerb reset', 'cd sub && kerb --json ack']) {
    const r = repo.kerb(['check', '--', c]);
    assert.equal(r.code, 77, c);
    assert.match(r.stderr, /^kerb: human_only · /m, c);
    assert.match(r.stderr, /next: ask the user to run this in their own terminal/, c);
  }
  assert.equal(repo.kerb(['check', '--', 'kerb status']).code, 0);
  assert.equal(repo.kerb(['check', '--', 'kerb run -- npm test']).code, 0);
});

test('H4 kerb ack without a TTY exits 64', () => {
  const { repo, check } = setup();
  check();
  check();
  const r = repo.kerb(['ack']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /human_only/);
  assert.equal(repo.kerb(['reset']).code, 64);
  assert.equal(repo.kerb(['run', '--force', '--', 'true']).code, 64);
});

test('H5 after ack, exactly one run is allowed; a same-fingerprint failure reopens the breaker', () => {
  const { repo, check, count } = setup();
  for (const v of ['1', '2', '3']) { repo.write('a.js', `${v}\n`); check(); }
  repo.write('a.js', '4\n');
  assert.equal(check().code, 75);
  const store = new Store(repo.dir);
  const key = records(repo.dir).find((r) => r.type === 'refusal').key;
  ackKey(store, key);
  assert.equal(check().code, 1, 'one run allowed after ack');
  repo.write('a.js', '5\n');
  const r = check();
  assert.equal(r.code, 75);
  assert.match(r.stderr, /breaker_open/);
  assert.equal(count(), 4);
});

test('H6 --force skips loop checks but not boundaries', async () => {
  const { repo, cmd, count } = setup({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  setHumanOverrideForTests(() => true);
  try {
    const c = cmd();
    await inproc(repo, ['run', '--class', 'check', '--', c]);
    assert.equal((await inproc(repo, ['run', '--class', 'check', '--', c])).code, 75);
    assert.equal((await inproc(repo, ['run', '--class', 'check', '--force', '--', c])).code, 1);
    assert.equal((await inproc(repo, ['run', '--force', '--', 'docker ps'])).code, 77);
  } finally {
    setHumanOverrideForTests(null);
  }
  assert.equal(count(), 2);
});

test('H6 no agent-reachable flag or variable disables Loopbreaker', () => {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(src);
  const allowedEnv = new Set(['KERB_EXIT_LOOP', 'KERB_EXIT_POLICY']);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/env(?:\.|\[['"])(KERB_[A-Z_]+)/g)) {
      assert.ok(allowedEnv.has(m[1]), `${path.basename(f)} reads ${m[1]}`);
    }
  }
  const runSpec = fs.readFileSync(path.join(src, 'cli', 'run.js'), 'utf8');
  const opts = /RUN_SPEC = \{([^}]+)\}/.exec(runSpec)[1];
  for (const bad of ['no-loop', 'skip', 'bypass', 'disable', 'unsafe', 'allow']) assert.ok(!opts.includes(bad), `run option ${bad}`);
  assert.ok(opts.includes('force'), '--force exists and is human-only');
});
