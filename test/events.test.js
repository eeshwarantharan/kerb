// EV · Event log extensions, KER schemas and indexes (KERB-V2 5.1–5.2, tests EV1–EV8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, records, runKerbAsync, ROOT } from './helpers.js';
import { Store, buildRuns } from '../src/store/jsonl.js';
import { validateRecord, kerRun, schemas } from '../src/platform/ker.js';
import { loadIndexes, rebuildIndexes, applyIndex, emptyIndexes, indexDir, FILES } from '../src/store/index.js';

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) };

/** A repo whose log holds every record type v1 and B1 write today. */
function busyRepo() {
  const repo = makeRepo({ git: true, files: { ...POLICY, 'a.js': '1\n' } });
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']); // identical_retry
  repo.kerb(['run', '--', 'docker ps']); // policy_blocked
  repo.write('a.js', '2\n');
  repo.kerb(['run', '--class', 'check', '--', 'true']);
  repo.kerb(['wait-for', '--max', '3s', '--', 'true']);
  repo.kerb(['run', '--', 'curl -sS https://blocked.example/x || echo "curl: (56) blocked by policy: blocked.example"; exit 56']);
  const p = { session_id: 'sess-hook', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'h1' };
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) });
  repo.kerb(['hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p, error: 'Exit code 1\nFAIL x' }) });
  return repo;
}

test('EV1 every record written today validates against its schema; v2-only types too', () => {
  const repo = busyRepo();
  const recs = records(repo.dir);
  const types = new Set(recs.map((r) => r.type));
  for (const t of ['session', 'state', 'start', 'end', 'refusal', 'wait', 'learn']) assert.ok(types.has(t), `log has ${t}`);
  for (const r of recs) assert.deepEqual(validateRecord(r), [], `${r.type} ${JSON.stringify(r)}`);
  const sessions = recs.filter((r) => r.type === 'session');
  assert.equal(new Set(sessions.map((s) => s.id)).size, sessions.length, 'one session record per session');
  assert.equal(sessions.find((s) => s.id === 'sess-hook').branch, 'main');
  for (const run of buildRuns(recs).filter((r) => r.finished)) assert.deepEqual(validateRecord(kerRun(run)), [], `run ${run.id}`);
  const st = 'st_0123456789abcdef';
  const future = [
    { type: 'test_result', run: 'r1', test_id: 'vitest:src/cart.test.js::cart > applies discount', status: 'fail', location: 'src/cart.test.js:42', message: 'expected 90, got 100', duration_ms: 4 },
    { type: 'cached_answer', id: 'c1', ts: 1, key: '.::tsc', state: st, source_run: 'r1' },
    { type: 'fix', id: 'f1', ts: 1, fingerprint: 'abc', family: 'fam', test_ids: ['t'], from_state: st, to_state: st, hunks: null, commit: null, confidence: 'full diff' },
    { type: 'finding', id: 'g1', ts: 1, kind: 'cause', test_id: 't', good_state: st, bad_state: st, culprit_hunks: [], probes: 7, confidence: 'confirmed', reason_if_undetermined: null },
    { type: 'note', id: 'n1', ts: 1, source: 'core', text: 'hello', level: 'info' },
    { type: 'would_refuse', id: 'w1', ts: 1, key: 'k', reason: 'deja_vu', matched_run: null, avoided_duration_ms: 0, avoided_output_bytes: 0 },
  ];
  for (const r of future) assert.deepEqual(validateRecord(r), [], r.type);
  assert.notDeepEqual(validateRecord({ type: 'test_result', run: 'r', test_id: 't', status: 'maybe' }), []);
  assert.notDeepEqual(validateRecord({ type: 'state', id: 'nope', ts: 1, mode: 'git', materializable: true }), []);
});

test('EV2 unknown fields and record types are tolerated by readers', () => {
  const repo = makeRepo({ git: true });
  const store = new Store(repo.dir);
  store.ensure().append([
    { type: 'start', id: 'x1', ts: 1, key: 'k', class: 'check', future_field: { a: 1 } },
    { type: 'end', id: 'x1', ts: 2, exit: 1, key: 'k', class: 'check', another: [1, 2] },
    { type: 'from_the_future', id: 'z', ts: 3, payload: 'x' },
  ]);
  const recs = store.read();
  assert.equal(recs.length, 3);
  assert.deepEqual(validateRecord(recs[0]), []);
  assert.deepEqual(validateRecord(recs[2]), [], 'unknown types are accepted');
  assert.equal(buildRuns(recs).filter((r) => r.finished).length, 1);
  assert.equal(loadIndexes(store).by_key.k.length, 1);
  assert.equal(repo.kerb(['history', '--json']).code, 0);
  assert.equal(repo.kerb(['status', '--json']).code, 0);
});

const indexFiles = (repo) => Object.fromEntries(['meta', ...FILES].map((f) => [f, fs.readFileSync(path.join(repo.dir, '.kerb/index', `${f}.json`), 'utf8')]));

test('EV3 indexes caught up incrementally equal indexes rebuilt from the log', () => {
  const repo = busyRepo();
  const store = new Store(repo.dir);
  loadIndexes(store); // build
  repo.kerb(['run', '--class', 'check', '--', 'echo again; exit 3']);
  repo.write('a.js', '3\n');
  repo.kerb(['run', '--class', 'check', '--', 'true']);
  const inc = loadIndexes(store); // catch up
  const incFiles = indexFiles(repo);
  const reb = rebuildIndexes(store);
  assert.deepEqual(reb, inc);
  assert.deepEqual(indexFiles(repo), incFiles);
  const key = Object.keys(inc.by_key).find((k) => k.includes('exit 3'));
  assert.equal(inc.by_key[key][0].exit, 3);
  const green = Object.entries(inc.verification).find(([k]) => k.endsWith('::true'));
  assert.equal(green[1].result, 'pass');
  assert.equal(inc.states[green[1].state].keys[green[0]], 'green');
  // Applying the same records twice changes nothing (crash between index files).
  const twice = applyIndex(applyIndex(emptyIndexes(), store.read()), store.read());
  const once = applyIndex(emptyIndexes(), store.read());
  for (const f of FILES) assert.deepEqual(twice[f], once[f], f);
});

test('EV4 a corrupt or missing index is rebuilt automatically', () => {
  const repo = busyRepo();
  const store = new Store(repo.dir);
  const good = loadIndexes(store);
  fs.writeFileSync(path.join(indexDir(store), 'by_key.json'), '{"torn":');
  assert.deepEqual(loadIndexes(store).by_key, good.by_key);
  fs.rmSync(indexDir(store), { recursive: true });
  assert.deepEqual(loadIndexes(store).verification, good.verification);
  fs.writeFileSync(path.join(indexDir(store), 'meta.json'), JSON.stringify({ ...good.meta, offset: 10 ** 9 }));
  assert.deepEqual(loadIndexes(store).by_key, good.by_key, 'a position past the end of the log rebuilds');
});

test('EV5 hooks work without indexes, within budget', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const p = (id) => ({ session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: id });
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('a')) });
  repo.kerb(['hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p('a'), error: 'Exit code 1\nFAIL' }) });
  assert.equal(fs.existsSync(path.join(repo.dir, '.kerb/index')), false);
  const t0 = Date.now();
  const r = repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('b')) });
  assert.ok(Date.now() - t0 < 1000, 'inside the 1 s hook deadline');
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(fs.existsSync(path.join(repo.dir, '.kerb/index')), false, 'hooks never write indexes');
});

test('EV6 twenty parallel runs keep indexes consistent', async () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const store = new Store(repo.dir);
  loadIndexes(store);
  const jobs = Array.from({ length: 20 }, (_, i) => runKerbAsync(['run', '--key', 'par', '--', `exit ${i % 3}`], { cwd: repo.dir, env: repo.env }));
  const readers = Array.from({ length: 5 }, () => runKerbAsync(['reindex'], { cwd: repo.dir, env: repo.env }));
  await Promise.all([...jobs, ...readers].map((j) => j.done));
  const ix = loadIndexes(store);
  assert.equal(ix.by_key.par.length, 20);
  assert.equal(new Set(ix.by_key.par.map((r) => r.id)).size, 20);
  assert.deepEqual(rebuildIndexes(store).by_key, ix.by_key);
});

test('EV7 reindex is idempotent', () => {
  const repo = busyRepo();
  assert.equal(repo.kerb(['reindex']).code, 0);
  const first = indexFiles(repo);
  const j = repo.kerb(['reindex', '--json']).json;
  assert.equal(j.rebuilt, true);
  assert.equal(j.runs, 5, "a failing check, a pass, a wait, a curl and the hooked npm test; refusals are not runs");
  assert.deepEqual(indexFiles(repo), first);
});

test('EV8 schemas published in docs match the code', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/ker-schemas.js'), '--check'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  const doc = fs.readFileSync(path.join(ROOT, 'docs/KER.md'), 'utf8');
  for (const [name, s] of Object.entries(schemas())) {
    assert.ok(doc.includes(JSON.stringify(s, null, 2)), `${name} is published verbatim`);
    assert.equal(s.properties.type.const ?? 'boundary', name === 'boundary' ? 'boundary' : name);
  }
});
