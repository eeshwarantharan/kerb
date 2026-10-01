import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, runKerbAsync, alive, waitFor, sleep, shPath } from './helpers.js';
import { decodeRecord } from '../src/store/jsonl.js';

const posix = process.platform !== 'win32';

const START_FIELDS = ['id', 'ts', 'key', 'class', 'cmd', 'cwd', 'scope', 'pre_hash', 'env_stamp', 'kerb_pid', 'pgid', 'agent', 'tier', 'session'];
const END_FIELDS = ['id', 'ts', 'exit', 'signal', 'duration_ms', 'post_hash', 'fingerprint', 'failure_kind', 'class_result', 'raw_bytes', 'shown_bytes', 'first_fail_line', 'loop_skipped'];
const REFUSAL_FIELDS = ['id', 'ts', 'key', 'reason', 'matched_run', 'avoided_duration_ms', 'avoided_output_bytes'];

test('C1 kerb check never executes', () => {
  const repo = makeRepo();
  const r = repo.kerb(['check', '--', 'touch side.txt']);
  assert.equal(r.code, 0);
  assert.equal(repo.exists('side.txt'), false);
  const j = repo.kerb(['check', '--json', '--', 'touch side.txt']);
  assert.equal(j.json.refused, false);
  assert.equal(repo.exists('side.txt'), false);
});

test('C2 kerb run writes start and end records with all fields', () => {
  const repo = makeRepo();
  const r = repo.kerb(['run', '--', 'echo hello; exit 3']);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, 'hello\n');
  const recs = records(repo.dir);
  const start = recs.find((x) => x.type === 'start');
  const end = recs.find((x) => x.type === 'end');
  for (const f of START_FIELDS) assert.ok(f in start, `start.${f}`);
  for (const f of END_FIELDS) assert.ok(f in end, `end.${f}`);
  assert.equal(start.id, end.id);
  assert.equal(end.exit, 3);
  assert.equal(end.class_result, 'failure');
  assert.equal(start.class, 'other');
  assert.equal(start.kerb_pid > 0, true);
  assert.equal(start.pgid > 0, true);
});

test('C3 refusals write a refusal record', () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker', why: 'no docker' }] }) } });
  const r = repo.kerb(['run', '--', 'docker ps > side.txt']);
  assert.equal(r.code, 77);
  assert.equal(repo.exists('side.txt'), false);
  const ref = records(repo.dir).find((x) => x.type === 'refusal');
  for (const f of REFUSAL_FIELDS) assert.ok(f in ref, `refusal.${f}`);
  assert.equal(ref.reason, 'policy_blocked');
});

test('R3 the recorded cmd is redacted', () => {
  const repo = makeRepo();
  repo.kerb(['run', '--', 'echo password=hunter2 > /dev/null']);
  const start = records(repo.dir).find((x) => x.type === 'start');
  assert.ok(!start.cmd.includes('hunter2'));
  assert.match(start.cmd, /\[REDACTED\]/);
});

test('B8 no footer for a successful, uncut command', () => {
  const repo = makeRepo();
  const r = repo.kerb(['run', '--', 'echo fine']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'fine\n');
  assert.equal(r.stderr, '');
});

test('B9 footer for failure, cut output and timeout', () => {
  const repo = makeRepo();
  const fail = repo.kerb(['run', '--', 'echo bad; exit 1']);
  assert.match(fail.stderr, /^kerb: exit 1 · .* · log \.kerb\/logs\/\S+\.log/m);
  const cut = repo.kerb(['run', '--budget', '500', '--', 'seq 1 2000']);
  assert.equal(cut.code, 0);
  assert.match(cut.stderr, /^kerb: exit 0 · /m);
  assert.match(cut.stdout, /\[kerb\] \d+ lines omitted · log /);
  const to = repo.kerb(['run', '--timeout', '1s', '--', 'sleep 20']);
  assert.equal(to.code, 124);
  assert.match(to.stderr, /^kerb: exit 124 · /m);
  assert.match(to.stderr, /total timeout/);
  const idle = repo.kerb(['run', '--idle', '1s', '--', 'echo x; sleep 20']);
  assert.equal(idle.code, 125);
});

test('B11 interleaving of stdout and stderr is preserved in the log', () => {
  const repo = makeRepo();
  repo.kerb(['run', '--', 'echo 1; echo 2 >&2; echo 3; echo 4 >&2; exit 1']);
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(fs.readFileSync(path.join(repo.dir, end.log), 'utf8'), '1\n2\n3\n4\n');
});

test('A6 SIGTERM to Kerb kills the group, records aborted, exits 143', { skip: !posix }, async () => {
  const repo = makeRepo();
  const pidFile = shPath(repo.dir, 'child.pid');
  const { child, done } = runKerbAsync(['run', '--', `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: repo.dir, env: repo.env });
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 5000);
  const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(child.pid, 'SIGTERM');
  const r = await done;
  assert.equal(r.code, 143);
  assert.equal(await waitFor(() => !alive(gpid), 5000), true, 'grandchild dead');
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(end.class_result, 'aborted');
});

test('A7 after SIGKILL to Kerb, the next invocation records aborted and kills the orphaned group', { skip: !posix }, async () => {
  const repo = makeRepo();
  const pidFile = shPath(repo.dir, 'child.pid');
  const { child, done } = runKerbAsync(['run', '--', `sleep 30 & echo $! > ${pidFile}; wait`], { cwd: repo.dir, env: repo.env });
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 5000);
  const gpid = Number(fs.readFileSync(pidFile, 'utf8'));
  process.kill(child.pid, 'SIGKILL');
  await done;
  assert.equal(alive(gpid), true, 'orphan still running before reaping');
  const r = repo.kerb(['run', '--', 'true']);
  assert.equal(r.code, 0);
  assert.equal(await waitFor(() => !alive(gpid), 5000), true, 'orphan killed');
  const ends = records(repo.dir).filter((x) => x.type === 'end');
  assert.ok(ends.some((e) => e.class_result === 'aborted'));
});

test('A8 a background command returns immediately, unshaped, recorded as background', { skip: !posix }, async () => {
  const repo = makeRepo();
  const t0 = Date.now();
  const { done } = runKerbAsync(['run', '--', 'sleep 5 &'], { cwd: repo.dir, env: repo.env });
  const r = await done;
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0}ms`);
  const start = records(repo.dir).find((x) => x.type === 'start');
  assert.equal(start.class, 'background');
});

test('S1 20 parallel kerb run -- true → 20 intact start/end pairs', async () => {
  const repo = makeRepo();
  const runs = Array.from({ length: 20 }, () => runKerbAsync(['run', '--', 'true'], { cwd: repo.dir, env: repo.env }));
  const results = await Promise.all(runs.map((r) => r.done));
  for (const r of results) assert.equal(r.code, 0);
  const lines = fs.readFileSync(path.join(repo.dir, '.kerb', 'runs.jsonl'), 'utf8').split('\n').filter(Boolean);
  const recs = lines.map((l) => decodeRecord(l));
  assert.ok(recs.every(Boolean), 'all crc-valid');
  const starts = new Set(recs.filter((r) => r.type === 'start').map((r) => r.id));
  const ends = new Set(recs.filter((r) => r.type === 'end').map((r) => r.id));
  assert.equal(starts.size, 20);
  assert.deepEqual([...starts].sort(), [...ends].sort());
});

test('--json run prints exactly one JSON object', () => {
  const repo = makeRepo();
  const r = repo.kerb(['run', '--json', '--', 'echo hi']);
  assert.equal(r.stdout.trim().split('\n').length, 1);
  assert.equal(r.json.exit, 0);
  assert.equal(r.json.output, 'hi\n');
});

test('stdin is /dev/null for the child', async () => {
  const repo = makeRepo();
  const r = repo.kerb(['run', '--', 'cat; echo end'], { input: 'should not be read\n' });
  assert.equal(r.stdout, 'end\n');
  await sleep(1);
});
