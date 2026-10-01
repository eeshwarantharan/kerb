import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, shPath } from './helpers.js';
import { loadSummary } from '../src/store/summary.js';

const stamp = (file) => `node -e "require('fs').appendFileSync('${file}', Date.now() + '\\\\n')"`;

test('WF1 succeeds on the 4th attempt → exit 0, one summary line, only the final output', () => {
  const repo = makeRepo();
  const n = shPath(repo.home, 'n');
  const cmd = `c=$(cat ${n} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${n}; echo "attempt $c"; [ $c -ge 4 ]`;
  const r = repo.kerb(['wait-for', '--interval', '1s', '--max', '30s', '--', cmd]);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'attempt 4\n');
  assert.match(r.stderr, /^kerb: wait-for · condition met after 4 attempts in \S+\n$/);
});

test('WF2 never succeeds → exit 124 at --max, "gave up", last output shown', () => {
  const repo = makeRepo();
  const t0 = Date.now();
  const r = repo.kerb(['wait-for', '--interval', '1s', '--max', '3s', '--', 'echo not yet; exit 1']);
  assert.equal(r.code, 124);
  assert.equal(r.stdout, 'not yet\n');
  assert.match(r.stderr, /kerb: wait-for · gave up after \d+ attempts in \S+; last output above/);
  assert.ok(Date.now() - t0 < 8000);
});

test('WF2 an attempt is never started too close to --max to show its output', () => {
  const repo = makeRepo();
  for (let i = 0; i < 3; i++) {
    const r = repo.kerb(['wait-for', '--interval', '1s', '--max', '2.02s', '--', 'sleep 0.2; echo not yet; exit 1']);
    assert.equal(r.code, 124);
    assert.equal(r.stdout, 'not yet\n');
  }
  for (const w of records(repo.dir).filter((x) => x.type === 'wait')) assert.equal(w.class_result, 'failure');
});

test('WF3 --interval is respected within ±10% plus scheduling tolerance', () => {
  const repo = makeRepo();
  const f = shPath(repo.home, 'times');
  repo.kerb(['wait-for', '--interval', '2s', '--max', '7s', '--', `${stamp(f)}; exit 1`]);
  const t = fs.readFileSync(f, 'utf8').trim().split('\n').map(Number);
  assert.ok(t.length >= 3);
  for (let i = 1; i < t.length; i++) {
    const gap = t[i] - t[i - 1];
    assert.ok(gap >= 1800 - 50 && gap <= 2200 + 400, `gap ${gap}`);
  }
});

test('WF4 --backoff doubles the interval', () => {
  const repo = makeRepo();
  const f = shPath(repo.home, 'times');
  repo.kerb(['wait-for', '--interval', '1s', '--backoff', '--max', '9s', '--', `${stamp(f)}; exit 1`]);
  const t = fs.readFileSync(f, 'utf8').trim().split('\n').map(Number);
  assert.ok(t.length >= 4, `attempts ${t.length}`);
  const gaps = t.slice(1).map((x, i) => x - t[i]);
  assert.ok(gaps[0] >= 850 && gaps[0] <= 1500, `gap0 ${gaps[0]}`);
  assert.ok(gaps[1] >= 1750 && gaps[1] <= 2600, `gap1 ${gaps[1]}`);
  assert.ok(gaps[2] >= 3550 && gaps[2] <= 4800, `gap2 ${gaps[2]}`);
});

test('WF5 --until output:ready stops when a line matches', () => {
  const repo = makeRepo();
  const n = shPath(repo.home, 'n');
  const cmd = `c=$(cat ${n} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${n}; if [ $c -ge 2 ]; then echo "server ready"; else echo starting; fi; exit 3`;
  const r = repo.kerb(['wait-for', '--until', 'output:ready', '--interval', '1s', '--max', '20s', '--', cmd]);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /condition met after 2 attempts/);
  const e = repo.kerb(['wait-for', '--until', 'exit:3', '--interval', '1s', '--max', '5s', '--', 'exit 3']);
  assert.equal(e.code, 0);
});

test('WF6 a blocked host → policy_blocked before any attempt', () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'blocked.example' }] }) } });
  const side = shPath(repo.home, 'side');
  const r = repo.kerb(['wait-for', '--', `touch ${side}; curl https://blocked.example/health`]);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /^kerb: policy_blocked/m);
  assert.equal(fs.existsSync(side), false);
});

test('WF7 out-of-range values are usage errors', () => {
  const repo = makeRepo();
  assert.equal(repo.kerb(['wait-for', '--interval', '0.5s', '--', 'true']).code, 64);
  assert.equal(repo.kerb(['wait-for', '--max', '45m', '--', 'true']).code, 64);
  assert.equal(repo.kerb(['wait-for', '--until', 'bogus', '--', 'true']).code, 64);
  assert.equal(repo.kerb(['wait-for', '--until', 'output:(', '--', 'true']).code, 64);
});

test('WF9 one wait record; a successful wait clears the key', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const n = shPath(repo.home, 'n');
  const cmd = `c=$(cat ${n} 2>/dev/null || echo 0); c=$((c+1)); echo $c > ${n}; echo "FAIL"; [ $c -ge 3 ]`;
  assert.equal(repo.kerb(['run', '--class', 'check', '--', cmd]).code, 1);
  assert.equal(repo.kerb(['run', '--class', 'check', '--', cmd]).code, 75);
  const w = repo.kerb(['wait-for', '--interval', '1s', '--max', '20s', '--', cmd]);
  assert.equal(w.code, 0);
  const waits = records(repo.dir).filter((r) => r.type === 'wait');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].attempts, 2);
  assert.equal(waits[0].result, 'met');
  // The key is cleared: the same command may run again (it passes now).
  assert.equal(repo.kerb(['run', '--class', 'check', '--', cmd]).code, 0);
});

test('WF10 folded attempts are counted', () => {
  const repo = makeRepo();
  repo.kerb(['wait-for', '--interval', '1s', '--max', '3s', '--', 'exit 1']);
  const s = loadSummary(path.join(repo.dir, '.kerb'));
  const day = Object.values(s.days)[0];
  const w = records(repo.dir).find((r) => r.type === 'wait');
  assert.equal(day.polls_folded, w.attempts - 1);
  assert.ok(day.polls_folded >= 1);
});
