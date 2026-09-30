import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, tmpDir, waitFor, baseEnv } from './helpers.js';
import { TASKS } from '../bench/tasks.js';

test('the benchmark has 20 to 30 tasks, including a 100,000-file monorepo', () => {
  assert.ok(TASKS.length >= 20 && TASKS.length <= 30, `${TASKS.length} tasks`);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length);
  assert.ok(TASKS.some((t) => t.id.startsWith('monorepo')));
  for (const c of ['wall', 'loop', 'transient', 'dependency', 'noise', 'hang']) assert.ok(TASKS.some((t) => t.category === c), c);
});

test('the harness runs a task with and without Kerb and writes rows and a summary', { timeout: 120_000 }, () => {
  const out = tmpDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/run.js'), '--tasks', 'fix-test-sum', '--runs', '1', '--out', out,
    '--agent-cmd', `${process.execPath} ${path.join(ROOT, 'bench/fake-agent.js')}`], { encoding: 'utf8', env: baseEnv() });
  assert.equal(r.status, 0, r.stderr);
  const rows = fs.readFileSync(path.join(out, 'rows.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  const withKerb = rows.find((x) => x.kerb);
  const bare = rows.find((x) => !x.kerb);
  assert.equal(bare.refusals.length, 0);
  assert.equal(withKerb.refusals.length, 1, 'the naive second run is refused');
  assert.equal(withKerb.refusals[0].reason, 'identical_retry');
  assert.equal(withKerb.refusals[0].correct, null, 'left for manual review');
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.with.runs, 1);
  assert.ok('success_within_1_point' in summary.launch_gate);
});

test('the egress proxy answers blocked hosts with 403 "blocked by policy"', async () => {
  const p = spawn(process.execPath, [path.join(ROOT, 'bench/proxy.js'), '--port', '18899', '--allow', 'localhost,127.0.0.1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  try {
    await waitFor(() => out.includes('egress proxy'), 5000);
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: 18899, path: 'http://registry.npmjs.org/left-pad' }, (res) => {
        let b = '';
        res.on('data', (d) => { b += d; });
        res.on('end', () => resolve({ status: res.statusCode, b }));
      });
    });
    assert.equal(body.status, 403);
    assert.equal(body.b, 'blocked by policy: registry.npmjs.org\n');
  } finally {
    p.kill();
  }
});
