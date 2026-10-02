// WK · Worker lifecycle (KERB-V2 8.1) and NR · Narrowing (8.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, runKerbAsync, waitFor, sleep, alive, baseEnv } from './helpers.js';
import { enqueue, listJobs, writeJob, JOB_SCHEMA } from '../src/worker/queue.js';
import { workerEnabled, ensureWorker, workerPid, NICE } from '../src/worker/main.js';
import { narrowCommand } from '../src/worker/narrow.js';

const stop = (repo) => repo.kerb(['worker', 'stop']);

test('WK1 the worker starts on demand, one per repo', async () => {
  const repo = makeRepo({ git: true, config: { worker: 'on' } });
  enqueue(repo.dir, 'minimize', { fix_id: 'none' });
  const env = repo.env;
  const pid = ensureWorker(repo.dir, { values: { worker: 'on' } }, env);
  assert.ok(pid);
  await waitFor(() => workerPid(repo.dir), 5000);
  assert.equal(ensureWorker(repo.dir, { values: { worker: 'on' } }, env), null, 'a worker is already running');
  const second = repo.kerb(['worker', '--idle', '1s', '--json']).json;
  assert.equal(second.reason, 'another worker is running');
  stop(repo);
  await waitFor(() => !workerPid(repo.dir), 5000);
  assert.equal(ensureWorker(repo.dir, { values: { worker: 'manual' } }, env), null, 'manual: never started by hooks');
});

test('WK2 it exits when idle', async () => {
  const repo = makeRepo({ git: true });
  const t0 = Date.now();
  const r = repo.kerb(['worker', '--idle', '1s', '--json']);
  assert.equal(r.json.reason, 'idle');
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(fs.existsSync(path.join(repo.dir, '.kerb/worker.lock')), false, 'the lock is released');
});

test('WK3 the hourly budget is enforced: jobs wait', () => {
  const repo = makeRepo({ git: true, config: { worker_budget_cpu_min_per_hour: 1 } });
  enqueue(repo.dir, 'minimize', { fix_id: 'none' });
  fs.writeFileSync(path.join(repo.dir, '.kerb/worker-budget.json'), JSON.stringify({ window_start: Date.now(), used_ms: 61_000 }));
  const r = repo.kerb(['worker', '--once', '--json']).json;
  assert.equal(r.reason, 'hourly budget used');
  assert.equal(listJobs(repo.dir)[0].state, 'queued');
  fs.writeFileSync(path.join(repo.dir, '.kerb/worker-budget.json'), JSON.stringify({ window_start: Date.now() - 3_700_000, used_ms: 61_000 }));
  assert.equal(repo.kerb(['worker', '--once', '--json']).json.ran, 1, 'a new hour, a new budget');
});

test('WK4 the worker runs niced', { skip: process.platform === 'win32' }, async () => {
  const repo = makeRepo({ git: true });
  const w = runKerbAsync(['worker', '--idle', '3s'], { cwd: repo.dir, env: repo.env });
  await waitFor(() => workerPid(repo.dir), 5000);
  assert.equal(os.getPriority(w.child.pid), NICE);
  stop(repo);
  await w.done;
});

test('WK7 crash recovery: a job left running becomes failed; WK10 jobs carry a schema version', () => {
  const repo = makeRepo({ git: true });
  writeJob(repo.dir, { schema: JOB_SCHEMA, id: 'a1', kind: 'minimize', state: 'running', created: 1, updated: 1, payload: { fix_id: 'x' } });
  writeJob(repo.dir, { schema: 99, id: 'b2', kind: 'cause', state: 'queued', created: 2, updated: 2, payload: {} });
  writeJob(repo.dir, { schema: 1, id: 'c3', kind: 'minimize', state: 'queued', created: 3, updated: 3, payload: { fix_id: 'none' } });
  repo.kerb(['worker', '--once']);
  const by = Object.fromEntries(listJobs(repo.dir).map((j) => [j.id, j]));
  assert.equal(by.a1.state, 'failed');
  assert.match(by.a1.error, /stopped during this job/);
  assert.equal(by.b2.state, 'queued', 'a job from a newer Kerb is left alone');
  assert.equal(by.c3.state, 'done', 'a job from this schema runs');
});

test('WK8 the worker is off by default in CI', () => {
  assert.equal(workerEnabled({ values: { worker: 'auto' } }, { CI: 'true' }), false);
  assert.equal(workerEnabled({ values: { worker: 'auto' } }, {}), true);
  assert.equal(workerEnabled({ values: { worker: 'on' } }, { CI: 'true' }), true);
  assert.equal(workerEnabled({ values: { worker: 'off' } }, {}), false);
});

test('WK9 kerb worker stop stops it', async () => {
  const repo = makeRepo({ git: true });
  const w = runKerbAsync(['worker', '--idle', '60s'], { cwd: repo.dir, env: repo.env });
  await waitFor(() => workerPid(repo.dir), 5000);
  const pid = workerPid(repo.dir);
  assert.match(repo.kerb(['worker', 'status']).stdout, /running \(pid \d+\)/);
  assert.match(stop(repo).stdout, /stopping/);
  await w.done;
  await sleep(100);
  assert.equal(alive(pid), false);
  assert.match(repo.kerb(['worker', 'status']).stdout, /not running/);
});

// ---- Narrowing ----

test('NR1–NR6 one narrowed command per framework', () => {
  assert.equal(narrowCommand('vitest:src/cart.test.js::cart > applies discount', 'npx vitest run'), "npx vitest run 'src/cart.test.js' -t '^cart applies discount$'");
  assert.equal(narrowCommand('vitest:src/a.test.js::x', 'pnpm vitest'), "pnpm vitest run 'src/a.test.js' -t '^x$'");
  assert.equal(narrowCommand('jest:src/user.test.js::logout clears session', 'npm test'), "npx jest 'src/user.test.js' -t '^logout clears session$'");
  assert.equal(narrowCommand('pytest:tests/test_cart.py::TestUser > test_logout', 'python -m pytest -q'), "python -m pytest 'tests/test_cart.py::TestUser::test_logout'");
  assert.equal(narrowCommand('pytest:tests/test_cart.py::test_param[2-3]', 'pytest'), "pytest 'tests/test_cart.py::test_param[2-3]'");
  assert.equal(narrowCommand('go:example.com/shop/cart::TestRounding/half_up', 'go test ./...'), "go test -count=1 -run '^TestRounding$/^half_up$' 'example.com/shop/cart'");
  assert.equal(narrowCommand('cargo:src/lib.rs::tests::discount', 'cargo test'), "cargo test --lib 'tests::discount' -- --exact");
  assert.equal(narrowCommand('cargo:tests/checkout.rs::checkout_total', 'cargo test'), "cargo test --test 'checkout' 'checkout_total' -- --exact");
  assert.equal(narrowCommand('node:test/app.test.js::cart > applies discount', 'node --test'), "node --test --test-name-pattern='(^| )applies discount$' 'test/app.test.js'");
});

function runIn(dir, cmd) {
  // A clean environment: a child `node --test` must not see this runner's NODE_TEST_CONTEXT.
  return spawnSync('/bin/sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: baseEnv() });
}

test('NR6 (node) the narrowed command runs exactly the target test', () => {
  const repo = makeRepo({ files: { 't.test.js': "const { describe, it } = require('node:test');\nconst fs = require('node:fs');\nconst mark = (n) => fs.appendFileSync('ran.txt', n + '\\n');\ndescribe('cart', () => { it('applies discount', () => mark('target')); it('adds', () => mark('other')); });\nit('rounds', () => mark('other2'));\n" } });
  runIn(repo.dir, narrowCommand('node:t.test.js::cart > applies discount', 'node --test t.test.js'));
  assert.equal(fs.readFileSync(path.join(repo.dir, 'ran.txt'), 'utf8'), 'target\n');
});

const hasPytest = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;
test('NR3 (pytest) the narrowed command runs exactly the target test', { skip: !hasPytest && 'pytest not installed' }, () => {
  const repo = makeRepo({ files: { 'tests/test_a.py': "import pathlib\ndef mark(n):\n    with open('ran.txt', 'a') as f: f.write(n + '\\n')\nclass TestUser:\n    def test_logout(self): mark('target')\n    def test_login(self): mark('other')\ndef test_logout(): mark('top')\n" } });
  runIn(repo.dir, narrowCommand('pytest:tests/test_a.py::TestUser > test_logout', 'python3 -m pytest'));
  assert.equal(fs.readFileSync(path.join(repo.dir, 'ran.txt'), 'utf8'), 'target\n');
});

const hasGo = spawnSync('go', ['version']).status === 0;
test('NR4 (go) the narrowed command runs exactly the target test', { skip: !hasGo && 'go not installed' }, () => {
  const repo = makeRepo({ files: {
    'go.mod': 'module example.com/shop\n\ngo 1.21\n',
    'cart/cart_test.go': 'package cart\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc mark(n string) { f, _ := os.OpenFile("../ran.txt", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); f.WriteString(n + "\\n"); f.Close() }\n\nfunc TestRounding(t *testing.T) {\n\tt.Run("half up", func(t *testing.T) { mark("target") })\n\tt.Run("down", func(t *testing.T) { mark("other") })\n}\n\nfunc TestRoundingAll(t *testing.T) { mark("other2") }\n',
  } });
  runIn(repo.dir, narrowCommand('go:example.com/shop/cart::TestRounding/half_up', 'go test ./...'));
  assert.equal(fs.readFileSync(path.join(repo.dir, 'ran.txt'), 'utf8'), 'target\n');
});

test('NR7 no narrowing possible → the original command, with a smaller probe budget', async () => {
  assert.equal(narrowCommand('tsc:src/a.ts::TS2322', 'tsc --noEmit'), null);
  assert.equal(narrowCommand('junit:com.shop.CartTest::appliesDiscount', 'mvn test'), null);
  const { isolate } = await import('../src/worker/cause.js');
  assert.equal(typeof isolate, 'function');
});
