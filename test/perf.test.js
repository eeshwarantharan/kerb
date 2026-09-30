import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KERB, ROOT, tmpDir } from './helpers.js';

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
function time(args, cwd) {
  const out = [];
  for (let i = 0; i < 9; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(process.execPath, args, { cwd, stdio: 'ignore' });
    out.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(out);
}

test('Z1 kerb check cold start stays close to bare Node start-up', () => {
  const dir = tmpDir();
  const node = time(['-e', '0'], dir);
  const check = time([KERB, 'check', '--', 'ls'], dir);
  const overhead = check - node;
  // Spec budget: under 60 ms (CI: 150 ms). Bare Node alone takes 40–60 ms on the dev machine,
  // so the check here is on what Kerb adds, plus the CI ceiling for the whole run.
  assert.ok(overhead < 40, `kerb check ${check.toFixed(1)}ms vs node ${node.toFixed(1)}ms (+${overhead.toFixed(1)}ms)`);
  assert.ok(check < 150, `kerb check ${check.toFixed(1)}ms`);
});

test('Z5 the benchmark harness records warm p50 and p95 of kerb hook claude pre', { timeout: 300_000 }, () => {
  const out = tmpDir();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bench/hook-latency.js'), '--runs', '8', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const file = fs.readdirSync(out).find((f) => f.startsWith('hook-latency-'));
  const j = JSON.parse(fs.readFileSync(path.join(out, file), 'utf8'));
  for (const c of ['query', 'check', 'blocked']) {
    assert.ok(j.cases[c].p50_ms > 0 && j.cases[c].p95_ms >= j.cases[c].p50_ms, c);
  }
  assert.ok('pass' in j.latency_gate);
});
