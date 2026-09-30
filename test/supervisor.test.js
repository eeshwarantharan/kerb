import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { supervise } from '../src/run/supervisor.js';
import { alive, tmpDir, waitFor } from './helpers.js';

const posix = process.platform !== 'win32';

async function run(cmd, o = {}) {
  let out = '';
  const s = supervise(cmd, { cwd: o.cwd || process.cwd(), env: process.env, onData: (d) => { out += d; }, ...o });
  const r = await s.done;
  return { ...r, out };
}

test('A1 exit codes 0, 1, 42 pass through', async () => {
  for (const code of [0, 1, 42]) {
    const r = await run(`exit ${code}`);
    assert.equal(r.exit, code);
    assert.equal(r.reason, 'exit');
  }
});

test('A2 stdin gives EOF immediately', async () => {
  const t0 = Date.now();
  const r = await run('cat; echo done', { timeoutMs: 10_000 });
  assert.equal(r.exit, 0);
  assert.match(r.out, /done/);
  assert.ok(Date.now() - t0 < 5000);
});

test('A3 total timeout kills sleep 30 well within 6 s', async () => {
  const t0 = Date.now();
  const r = await run('sleep 30', { timeoutMs: 1000 });
  assert.equal(r.reason, 'timeout');
  assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0}ms`);
});

test('A4 idle timeout fires when output stops', async () => {
  const r = await run('echo start; sleep 30', { idleMs: 1000, timeoutMs: 20_000 });
  assert.equal(r.reason, 'idle');
  assert.match(r.out, /start/);
});

test('A5 a TERM-trapping grandchild is dead after timeout', { skip: !posix }, async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'gc.pid');
  const script = `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while true; do sleep 1; done' & wait`;
  const t0 = Date.now();
  const r = await run(script, { timeoutMs: 1000 });
  assert.equal(r.reason, 'timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  assert.equal(await waitFor(() => !alive(pid), 2000), true, 'grandchild killed');
  assert.ok(Date.now() - t0 < 8000);
});

test('stdout and stderr are merged in arrival order', async () => {
  const r = await run('echo one; echo two 1>&2; echo three');
  assert.equal(r.out, 'one\ntwo\nthree\n');
});

test('a background grandchild holding the pipe does not block completion', { skip: !posix }, async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'bg.pid');
  const t0 = Date.now();
  const r = await run(`(sleep 20 & echo $! > ${pidFile}); echo ok`, { timeoutMs: 30_000 });
  assert.equal(r.exit, 0);
  assert.ok(Date.now() - t0 < 5000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
});
