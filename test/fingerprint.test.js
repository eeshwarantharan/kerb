import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeText, compilePatterns, normalizeLine } from '../src/loop/fingerprint.js';
import { makeRepo, records } from './helpers.js';

const fp = (t, p, o) => analyzeText(t, p, o).fingerprint;
const kind = (t, p, o) => analyzeText(t, p, o).kind;

test('F1 differences only in volatile values give the same fingerprint', () => {
  const a = [
    '2026-10-01T10:11:12.345Z starting',
    '[10:11:12] compiling',
    'Oct  1 10:11:12 host app[1]: x',
    'done in 1.5s',
    'segfault at 0x7ffee1234abc',
    'wrote /tmp/jest_abc123/cache.json',
    `wrote /var/folders/xy/T/tmp-9981/out.txt`,
    'worker pid 4242 exited',
    'PID: 777',
    'listening on localhost:54321',
    'RequestId: 8a4f1c2e-1b2c-4d5e-8f90-123456789abc',
    'request 0a1b2c3d-1111-2222-3333-444455556666 failed',
    'FAIL test/a.test.js (38 ms)',
  ].join('\n');
  const b = [
    '2026-10-02T23:59:01.001Z starting',
    '[23:59:01] compiling',
    'Oct  2 23:59:01 host app[1]: x',
    'done in 0.9s',
    'segfault at 0x7ffee9999def',
    'wrote /tmp/jest_zzz999/cache.json',
    `wrote /var/folders/ab/T/tmp-1234/out.txt`,
    'worker pid 99 exited',
    'PID: 1',
    'listening on localhost:60001',
    'RequestId: 11111111-2222-3333-4444-555555555555',
    'request ffffffff-1111-2222-3333-444455556666 failed',
    'FAIL test/a.test.js (1203 ms)',
  ].join('\n');
  assert.equal(fp(a), fp(b));
});

test('F2 a different line number, test name or assertion value gives a different fingerprint', () => {
  const base = 'src/a.js:10:5 expected 3 to equal 4\n  ✕ adds numbers';
  assert.notEqual(fp(base), fp(base.replace('10:5', '11:5')));
  assert.notEqual(fp(base), fp(base.replace('adds numbers', 'subtracts numbers')));
  assert.notEqual(fp(base), fp(base.replace('equal 4', 'equal 5')));
  assert.notEqual(fp('listening on localhost:3000'), fp('listening on localhost:3001'));
});

test('F3 "handles 10s timeout" in a test name is not normalised', () => {
  assert.equal(normalizeLine('  ✕ handles 10s timeout'), '  ✕ handles 10s timeout');
  assert.notEqual(fp('✕ handles 10s timeout'), fp('✕ handles 20s timeout'));
});

test('F4 (38 ms) and in 1.2s are normalised', () => {
  assert.equal(normalizeLine('ok (38 ms)'), 'ok (<DUR>)');
  assert.equal(normalizeLine('built in 1.2s'), 'built in <DUR>');
  assert.equal(normalizeLine('Time: 4.2s, Tests: 3'), 'Time: <DUR>, Tests: 3');
  assert.equal(normalizeLine('finished 12ms'), 'finished <DUR>');
  assert.equal(normalizeLine('  duration_ms: 1.680041'), '  duration_ms: <DUR>');
  assert.equal(normalizeLine('{"elapsed_ms": 45}'), '{"elapsed_ms": <DUR>}');
  assert.equal(normalizeLine('retries: 3'), 'retries: 3');
});

test('F5 the Kerb footer does not affect the fingerprint', () => {
  assert.equal(fp('boom\n'), fp('boom\nkerb: exit 1 · 2s · 5 B → 5 B · log .kerb/logs/x.log\n'));
});

test('F6 ECONNRESET → transient', () => {
  assert.equal(kind('Error: read ECONNRESET'), 'transient');
});

test('F7 a Kerb timeout → transient', () => {
  assert.equal(kind('still running', {}, { timedOut: true }), 'transient');
  const repo = makeRepo();
  repo.kerb(['run', '--class', 'check', '--timeout', '1s', '--', 'sleep 10']);
  const end = records(repo.dir).find((r) => r.type === 'end');
  assert.equal(end.failure_kind, 'transient');
  assert.equal(end.class_result, 'timeout');
});

test('F8 an ordinary assertion failure → ordinary', () => {
  assert.equal(kind('AssertionError: expected 1 to equal 2'), 'ordinary');
});

test('F9 gateway and throttling errors → transient', () => {
  for (const line of ['HTTP 504 Gateway Timeout', '504 Gateway Time-out', 'ThrottlingException: Rate exceeded', 'RequestLimitExceeded', 'SlowDown: Please reduce your request rate', '429 Too Many Requests', 'grpc: UNAVAILABLE: connection lost', 'RESOURCE_EXHAUSTED']) {
    assert.equal(kind(line), 'transient', line);
  }
});

test('F10 500 Internal Server Error → ordinary', () => {
  assert.equal(kind('GET /api -> 500 Internal Server Error'), 'ordinary');
  assert.equal(kind('Error: table "users" does not exist'), 'ordinary');
});

test('F11 ECONNREFUSED 127.0.0.1:5432 → dependency-unavailable', () => {
  assert.equal(kind('Error: connect ECONNREFUSED 127.0.0.1:5432'), 'dependency');
  assert.equal(kind('psql: could not connect to server: Connection refused'), 'dependency');
  assert.equal(kind('ssh: connect to host 10.0.0.5 port 22: No route to host'), 'dependency');
  assert.equal(kind('connect: No route to host 8.8.8.8'), 'ordinary');
});

test('F12 policy patterns mark failures transient or dependency-unavailable', () => {
  const policy = {
    transient: compilePatterns(['AccessDeniedException: .* is not authorized .* \\(propagation\\)']),
    dependency: compilePatterns(['waiting for localstack']),
  };
  assert.equal(kind('AccessDeniedException: role is not authorized yet (propagation)', policy), 'transient');
  assert.equal(kind('waiting for localstack', policy), 'dependency');
  assert.equal(kind('waiting for localstack'), 'ordinary');
  // Lines over 4 KB are skipped for pattern matching (Z6).
  const long = `${'x'.repeat(5000)} waiting for localstack`;
  const t0 = Date.now();
  assert.equal(kind(long, policy), 'ordinary');
  assert.ok(Date.now() - t0 < 1000);
});

test('Z6 policy regexes are only applied to lines up to 4 KB', () => {
  const evil = compilePatterns(['(a+)+$']);
  const line = `${'a'.repeat(1024 * 1024)}!`;
  const t0 = Date.now();
  analyzeText(line, { transient: evil });
  assert.ok(Date.now() - t0 < 2000, 'a 1 MB line does not stall matching');
});
