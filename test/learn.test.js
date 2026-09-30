import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, inproc } from './helpers.js';
import { setClock } from '../src/util/core.js';
import { forgetLearned, loadLearned } from '../src/bound/learn.js';

/** A repo with a fake `curl` that prints the given text and fails. */
function fakeCurl(text) {
  const repo = makeRepo({ files: { curl: `#!/bin/sh\necho "${text}"\nexit 56\n` } });
  fs.chmodSync(path.join(repo.dir, 'curl'), 0o755);
  return repo;
}
const learned = (repo) => {
  const f = path.join(repo.home, '.kerb', 'learned.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('D1 "blocked by policy: a.example" from curl to a.example → confirmed; the next call is refused', () => {
  const repo = fakeCurl('curl: (56) CONNECT tunnel: blocked by policy: a.example');
  const r = repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.equal(r.code, 56);
  assert.match(r.stderr, /kerb: note · recorded a policy block for a\.example; it will be refused before running next time/);
  const e = learned(repo);
  assert.equal(e.length, 1);
  assert.equal(e[0].status, 'confirmed');
  assert.equal(e[0].pattern, 'a.example');
  const again = repo.kerb(['run', '--', './curl https://a.example/y']);
  assert.equal(again.code, 77);
  assert.match(again.stderr, /source: learned from a policy denial/);
  assert.match(again.stderr, /next: this is blocked here; tell the user what you need and why/);
});

test('D2 the same text from cat notes.txt → nothing learned', () => {
  const repo = makeRepo({ files: { 'notes.txt': 'blocked by policy: a.example\n' } });
  repo.kerb(['run', '--', 'cat notes.txt; exit 1']);
  assert.deepEqual(learned(repo), []);
});

test('D3 a test suite printing "blocked by policy" for a host it did not contact → nothing learned', () => {
  const repo = fakeCurl('blocked by policy: a.example');
  repo.kerb(['run', '--', './curl https://b.example/x']);
  repo.kerb(['run', '--', 'echo "blocked by policy: registry.npmjs.org"; npm test; exit 1']);
  assert.deepEqual(learned(repo), []);
});

test('D4 a signature line without a host → nothing learned', () => {
  const repo = fakeCurl('request blocked by policy');
  repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.deepEqual(learned(repo), []);
});

test('D5 ENOTFOUND a.example → suspected; not blocking', () => {
  const repo = fakeCurl('getaddrinfo ENOTFOUND a.example');
  repo.kerb(['run', '--', './curl https://a.example/x']);
  const e = learned(repo);
  assert.equal(e.length, 1);
  assert.equal(e[0].status, 'suspected');
  const again = repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.equal(again.code, 56, 'still runs');
  assert.match(again.stderr, /kerb: note · a\.example may be blocked here/);
});

test('D6 a second hit from a different key → confirmed', () => {
  const repo = fakeCurl('Could not resolve host: a.example');
  repo.kerb(['run', '--', './curl https://a.example/x']);
  repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.equal(learned(repo)[0].status, 'suspected', 'same key twice stays suspected');
  repo.kerb(['run', '--', './curl -s https://a.example/other']);
  const e = learned(repo)[0];
  assert.equal(e.status, 'confirmed');
  assert.equal(e.keys.length, 2);
  assert.equal(repo.kerb(['check', '--', 'curl https://a.example/z']).code, 77);
});

test('D7 entries expire 14 days after their last hit', async () => {
  const repo = fakeCurl('blocked by policy: a.example');
  let t = 1_700_000_000_000;
  setClock(() => t);
  try {
    await inproc(repo, ['run', '--', './curl https://a.example/x']);
    t += 13 * 86_400_000;
    assert.equal((await inproc(repo, ['check', '--', 'curl https://a.example/x'])).code, 77);
    t += 2 * 86_400_000;
    assert.equal((await inproc(repo, ['check', '--', 'curl https://a.example/x'])).code, 0);
  } finally {
    setClock(null);
  }
});

test('D8 kerb forget removes an entry (human-only)', async () => {
  const repo = fakeCurl('blocked by policy: a.example');
  repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.equal(repo.kerb(['forget', 'a.example']).code, 64, 'needs a human');
  assert.equal(learned(repo).length, 1);
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  try {
    assert.equal(forgetLearned('a.example').length, 1);
    assert.equal(loadLearned(Date.now()).length, 0);
  } finally {
    process.env.HOME = oldHome;
  }
  assert.equal(repo.kerb(['check', '--', 'curl https://a.example/x']).code, 0);
});

test('D9 a two-host command learns only the host named on the signature line', () => {
  const repo = fakeCurl('Error: blocked by policy: b.example');
  repo.kerb(['run', '--', './curl https://a.example/x https://b.example/y']);
  assert.deepEqual(learned(repo).map((e) => e.pattern), ['b.example']);
});

test('D10 the denial run does not count for Loopbreaker', () => {
  const repo = fakeCurl('blocked by policy: a.example');
  repo.kerb(['run', '--class', 'check', '--', './curl https://a.example/x']);
  const end = records(repo.dir).find((r) => r.type === 'end');
  assert.equal(end.class_result, 'policy_denial');
  assert.equal(end.failure_kind, null);
  const r = repo.kerb(['run', '--class', 'check', '--', './curl https://a.example/x']);
  assert.match(r.stderr, /policy_blocked/);
  assert.ok(!/identical_retry/.test(r.stderr));
});

test('kerb map lists boundaries with source, status, hits and expiry', () => {
  const repo = fakeCurl('blocked by policy: a.example');
  repo.write('kerb.policy.json', JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker', why: 'no docker' }] }));
  repo.kerb(['run', '--', './curl https://a.example/x']);
  repo.kerb(['run', '--', 'docker ps']);
  const m = repo.kerb(['map', '--json']);
  const docker = m.json.boundaries.find((b) => b.pattern === 'docker');
  assert.equal(docker.hits, 1);
  assert.equal(docker.source, 'repo policy (kerb.policy.json)');
  const a = m.json.boundaries.find((b) => b.pattern === 'a.example');
  assert.equal(a.status, 'confirmed');
  assert.ok(a.expires > Date.now());
  assert.match(repo.kerb(['map']).stdout, /host a\.example · learned from a policy denial · 1 hit · expires/);
});
