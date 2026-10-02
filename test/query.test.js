// QY · kerb query and kerb export (KERB-V2 11.1, 11.4, tests QY1–QY6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records } from './helpers.js';
import { Store } from '../src/store/jsonl.js';
import { validateQuery, QUERY_NAMES } from '../src/platform/query.js';
import { validateRecord } from '../src/platform/ker.js';

const CMD = 'node --test test/app.test.js';
const mod = (name, body) => `${body}\nmodule.exports = { ${name} };\n`;
const TEST_FILE = [
  "const { it } = require('node:test');", "const assert = require('node:assert/strict');", "const { logout } = require('../src/session.js');",
  "it('logout clears session', () => { assert.equal(logout({ user: 'a' }).user, null); });",
  "it('always passes', () => {});",
].join('\n');
const GOOD = mod('logout', 'function logout(s) {\n  s.user = null;\n  return s;\n}');
const BAD = (v) => mod('logout', `function logout(s) {\n  s.user = s.user; // ${v}\n  return s;\n}`);

let shared = null;
/** One fixture log for every query: green, red, green (a fix), red again, plus a finding and a refusal. */
function fixture() {
  if (shared) return shared;
  const repo = makeRepo({ git: true, config: { worker: 'manual' }, files: { 'src/session.js': GOOD, 'test/app.test.js': `${TEST_FILE}\n` } });
  const run = () => repo.kerb(['run', '--', CMD]);
  run();
  repo.write('src/session.js', BAD('one'));
  run();
  repo.write('src/session.js', GOOD.replace('s.user = null;', 's.user = null; // fixed'));
  run();
  repo.write('src/session.js', BAD('two'));
  run();
  const recs = records(repo.dir);
  const ends = recs.filter((r) => r.type === 'end');
  new Store(repo.dir).append([
    { type: 'finding', id: '3b2e5a71c0', ts: Date.now(), kind: 'cause', key: ends[3].key, test_id: 'node:test/app.test.js::logout clears session', good_state: ends[2].post_hash, bad_state: ends[3].post_hash,
      culprit_hunks: ['src/session.js#0'], locations: ['src/session.js:2'], hunk_count: 1, probes: 7, confidence: 'confirmed', reason_if_undetermined: null },
    { type: 'refusal', id: 'rf1', ts: Date.now(), key: ends[3].key, reason: 'identical_retry', matched_run: ends[3].id, cmd: CMD, summary: 'same files as a failed run', evidence: 'token=sk-ant-0123456789abcdefghijklmnop at /Users/someone/project', avoided_duration_ms: 10, avoided_output_bytes: 10 },
  ]);
  shared = { repo, ends };
  return shared;
}
const q = (repo, ...args) => {
  const r = repo.kerb(['query', ...args]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};
const valid = (res) => assert.deepEqual(validateQuery(res), [], JSON.stringify(res).slice(0, 400));

test('QY1 runs: schema-valid, newest first, filtered by key, status, state and time', () => {
  const { repo, ends } = fixture();
  const all = q(repo, 'runs');
  valid(all);
  assert.equal(all.runs.length, 4);
  assert.equal(all.runs[0].id, ends[3].id, 'newest first');
  for (const r of all.runs) assert.deepEqual(validateRecord(r), []);
  assert.deepEqual(q(repo, 'runs', '--status', 'failure').runs.map((r) => r.id), [ends[3].id, ends[1].id]);
  assert.deepEqual(q(repo, 'runs', '--state', ends[2].post_hash).runs.map((r) => r.id), [ends[2].id], 'its pre- or post-state');
  assert.equal(q(repo, 'runs', '--key', CMD, '--limit', '1').runs.length, 1);
  assert.equal(q(repo, 'runs', '--key', 'npm test').runs.length, 0);
  assert.equal(q(repo, 'runs', '--since', '1h').runs.length, 4);
  assert.equal(repo.kerb(['query', 'runs', '--green']).code, 64, 'options are per query');
  assert.equal(repo.kerb(['query', 'nothing']).code, 64);
});

test('QY2 tests and verification: schema-valid', () => {
  const { repo } = fixture();
  const t = q(repo, 'tests');
  valid(t);
  const byId = Object.fromEntries(t.tests.map((x) => [x.test_id, x]));
  assert.equal(byId['node:test/app.test.js::logout clears session'].status, 'failing');
  assert.equal(byId['node:test/app.test.js::logout clears session'].failures, 2);
  assert.equal(byId['node:test/app.test.js::always passes'].status, 'passing');
  assert.deepEqual(q(repo, 'tests', '--status', 'failing').tests.map((x) => x.test_id), ['node:test/app.test.js::logout clears session']);
  assert.equal(q(repo, 'tests', '--test', 'always passes').tests.length, 1);
  const v = q(repo, 'verification');
  valid(v);
  assert.deepEqual(v.keys.map((k) => [k.command, k.status]), [[CMD, 'red']]);
  assert.deepEqual(v.keys, repo.kerb(['status', '--json']).json.verification.map(({ current, ...x }) => (void current, x)), 'the same as kerb status');
});

test('QY3 progress, fixes and findings: schema-valid', () => {
  const { repo, ends } = fixture();
  const p = q(repo, 'progress');
  valid(p);
  assert.deepEqual(p.keys[0].runs, [ends[3].id]);
  const f = q(repo, 'fixes');
  valid(f);
  assert.equal(f.fixes.length, 1);
  assert.equal(f.fixes[0].to_run, ends[2].id);
  assert.equal(q(repo, 'fixes', '--test', 'logout clears session').fixes.length, 1);
  assert.equal(q(repo, 'fixes', '--fingerprint', f.fixes[0].fingerprint).fixes.length, 1);
  assert.equal(q(repo, 'fixes', '--fingerprint', 'nope').fixes.length, 0);
  const fi = q(repo, 'findings', '--test', 'logout clears session');
  valid(fi);
  assert.equal(fi.findings[0].id, '3b2e5a71c0');
  assert.equal(q(repo, 'findings', '--test', 'always passes').findings.length, 0);
});

test('QY4 states: schema-valid, kept states only, --green', () => {
  const { repo, ends } = fixture();
  const s = q(repo, 'states');
  valid(s);
  assert.ok(s.states.length >= 3);
  assert.ok(s.states.every((x) => /^st_[0-9a-f]{16}$/.test(x.id)));
  const g = q(repo, 'states', '--green');
  valid(g);
  assert.deepEqual(g.states.map((x) => x.run), [ends[2].id, ends[0].id]);
  assert.ok(g.states.every((x) => x.green));
  assert.deepEqual(QUERY_NAMES.sort(), ['findings', 'fixes', 'progress', 'runs', 'states', 'tests', 'verification']);
});

test('QY5 export is KER NDJSON, redacted, with runs instead of start/end', () => {
  const { repo } = fixture();
  const out = repo.kerb(['export', '--format', 'ker']).stdout;
  const recs = out.trim().split('\n').map((l) => JSON.parse(l));
  const types = new Set(recs.map((r) => r.type));
  assert.ok(types.has('run') && types.has('test_result') && types.has('fix') && types.has('finding') && types.has('refusal'));
  assert.ok(!types.has('start') && !types.has('end'));
  for (const r of recs) {
    assert.equal(r.crc, undefined);
    assert.deepEqual(validateRecord(r), [], JSON.stringify(r));
  }
  assert.doesNotMatch(out, /sk-ant-0123456789/);
  assert.match(out, /\[REDACTED\]/);
  assert.equal(recs.filter((r) => r.type === 'fix').length, 1, 'the latest version of each fix');
  const file = path.join(repo.home, 'out.ndjson');
  assert.match(repo.kerb(['export', '--out', file]).stdout, /^kerb export · \d+ records → /);
  assert.equal(fs.readFileSync(file, 'utf8'), out);
  assert.equal(repo.kerb(['export', '--format', 'csv']).code, 64);
  assert.equal(repo.kerb(['export', '--since', '1h', '--json']).json.count, recs.length);
});

test('QY6 export --no-text removes all text and paths, leaving ids, counts and hashes', () => {
  const { repo } = fixture();
  const out = repo.kerb(['export', '--no-text']).stdout;
  const recs = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(recs.length > 10);
  const strings = [];
  const walk = (v) => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  recs.forEach(walk);
  for (const s of strings) assert.match(s, /^[\w.:+-]*$|^(best effort|full diff)$/, `no text or paths: ${s}`); // two codes have a space
  assert.doesNotMatch(out, /node --test|session\.js|logout|app\.test|REDACTED|Users/);
  const run = recs.find((r) => r.type === 'run');
  assert.match(run.key, /^h:[0-9a-f]{16}$/);
  assert.equal(typeof run.exit, 'number');
  assert.equal(run.cmd, undefined);
  const t = recs.find((r) => r.type === 'test_result' && r.status === 'fail');
  assert.match(t.test_id, /^h:[0-9a-f]{16}$/);
  assert.equal(t.message, undefined);
});
