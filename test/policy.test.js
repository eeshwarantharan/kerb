import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc, tmpDir } from './helpers.js';
import { lintPolicy, mergeLayers } from '../src/bound/policy.js';
import { setManagedConfigPathForTests } from '../src/config.js';

const policyFile = (p) => ({ 'kerb.policy.json': JSON.stringify(p) });

test('M1 the repo policy loads; lint catches unknown keys and bad kinds', () => {
  const repo = makeRepo({ files: policyFile({ version: 1, boundaries: [{ kind: 'program', pattern: 'docker' }], colour: 'red' }) });
  assert.equal(repo.kerb(['run', '--', 'docker ps']).code, 77);
  const warn = repo.kerb(['policy', 'lint']);
  assert.equal(warn.code, 0);
  assert.match(warn.stdout, /warning: unknown key: colour/);
  repo.write('kerb.policy.json', JSON.stringify({ boundaries: [{ kind: 'url', pattern: 'x' }] }));
  const bad = repo.kerb(['policy', 'lint', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.problems[0].message, /kind must be one of/);
});

test('M2 an org block cannot be removed or loosened by the repo policy', () => {
  const merged = mergeLayers([
    { name: 'org', version: 42, source: 'org policy v42', policy: { boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp', why: 'mirror' }] } },
    { name: 'repo', source: 'repo policy (kerb.policy.json)', policy: { boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://evil.example' }] } },
  ]);
  const b = merged.boundaries.filter((x) => x.pattern === 'registry.npmjs.org');
  assert.equal(b.length, 1);
  assert.equal(b[0].layer, 'org');
  assert.equal(b[0].alternative, 'https://npm.corp');
});

test('M3 a repo alternative is shown as "from repo policy"', () => {
  const repo = makeRepo({ files: policyFile({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp.internal', why: 'use the mirror' }] }) });
  const r = repo.kerb(['check', '--', 'npm install left-pad']);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /next: use https:\/\/npm\.corp\.internal instead \(from repo policy\)/);
  assert.match(r.stderr, /source: repo policy \(kerb\.policy\.json\) · use the mirror/);
});

test('M4 locked repo alternatives are ignored', async () => {
  const repo = makeRepo({ files: policyFile({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://evil.example' }] }) });
  const dir = tmpDir();
  const managed = path.join(dir, 'managed.json');
  fs.writeFileSync(managed, JSON.stringify({ lock_repo_alternatives: true }));
  setManagedConfigPathForTests(managed);
  try {
    const r = await inproc(repo, ['check', '--', 'npm install left-pad']);
    assert.equal(r.code, 77);
    assert.ok(!r.stderr.includes('evil.example'));
    assert.match(r.stderr, /next: this is blocked here; tell the user what you need and why/);
  } finally {
    setManagedConfigPathForTests(null);
  }
});

test('M5 check_commands extends the check class', () => {
  const repo = makeRepo({ files: policyFile({ check_commands: ['just test', 'bazel test *'] }) });
  assert.equal(repo.kerb(['check', '--json', '--', 'just test']).json.class, 'check');
  assert.equal(repo.kerb(['check', '--json', '--', 'bazel test //pkg:all']).json.class, 'check');
  assert.equal(repo.kerb(['check', '--json', '--', 'just build']).json.class, 'other');
});

test('M6 a fixes hint appears in the footer of a matching failure', () => {
  const repo = makeRepo({ files: policyFile({ fixes: [{ key_contains: 'db-test', output_contains: 'ECONNREFUSED 127.0.0.1:5432', hint: 'Start the database first: make db-up' }] }) });
  const r = repo.kerb(['run', '--key', 'db-test', '--', 'echo "Error: connect ECONNREFUSED 127.0.0.1:5432"; exit 1']);
  assert.match(r.stderr, /^kerb: exit 1 · .*\n\s+hint: Start the database first: make db-up$/m);
  const other = repo.kerb(['run', '--key', 'other', '--', 'echo "Error: connect ECONNREFUSED 127.0.0.1:5432"; exit 1']);
  assert.ok(!other.stderr.includes('hint:'));
});

test('M7 lint rejects an invalid regex, a pattern over 200 characters, and more than 50 patterns', () => {
  const errs = (p) => lintPolicy(p).filter((x) => x.level === 'error').map((x) => x.message).join('\n');
  assert.match(errs({ transient_patterns: ['(unclosed'] }), /not a valid regular expression/);
  assert.match(errs({ dependency_patterns: ['x'.repeat(201)] }), /201 characters \(max 200\)/);
  assert.match(errs({ transient_patterns: Array.from({ length: 51 }, (_, i) => `p${i}`) }), /51 patterns \(max 50\)/);
  assert.equal(errs({ transient_patterns: ['ok \\(propagation\\)'] }), '');
});

test('M8 list settings merge across layers; numeric settings take the higher layer', () => {
  const m = mergeLayers([
    { name: 'org', source: 'org', policy: { breaker_threshold: 5, check_commands: ['just test'], transient_patterns: ['A'] } },
    { name: 'repo', source: 'repo', policy: { breaker_threshold: 2, retry_cooldown: '30s', check_commands: ['make ci'], transient_patterns: ['B'] } },
  ]);
  assert.equal(m.breaker_threshold, 5);
  assert.equal(m.retry_cooldown_ms, 30_000);
  assert.deepEqual(m.check_commands, ['just test', 'make ci']);
  assert.deepEqual(m.transient_patterns, ['A', 'B']);
});
