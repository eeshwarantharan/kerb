// GR · Last green and restore (KERB-V2 7.5, tests GR1–GR8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, inproc, shPath } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { Store } from '../src/store/jsonl.js';
import { readState } from '../src/state/keep.js';
import { treeHunks, scopeSpecs } from '../src/state/hunks.js';

/** A check whose result the test controls (output file kept outside the repo). */
function suite(repo) {
  const out = shPath(repo.home, 'out.txt');
  const code = shPath(repo.home, 'code');
  const cmd = `cat ${out}; exit $(cat ${code})`;
  return {
    cmd,
    run(results, cwd) {
      const lines = ['============================= test session starts ==============================', ''];
      for (const [t, s] of Object.entries(results)) lines.push(`tests/test_cart.py::${t} ${s ? 'PASSED' : 'FAILED'}`);
      const failed = Object.values(results).filter((v) => !v).length;
      lines.push(`========================= ${failed} failed, ${Object.keys(results).length - failed} passed in 0.01s =========================`);
      fs.writeFileSync(out, lines.join('\n'));
      fs.writeFileSync(code, failed ? '1' : '0');
      return repo.kerb(['run', '--class', 'check', '--', cmd], cwd ? { cwd } : {});
    },
  };
}
const greenRuns = (repo) => records(repo.dir).filter((r) => r.type === 'end' && r.exit === 0);

test('GR1 green finds the newest passing state for a key', () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n' } });
  const s = suite(repo);
  s.run({ test_a: true });
  repo.write('cart.py', 'v = 2\n');
  s.run({ test_a: true });
  const want = greenRuns(repo).pop().post_hash;
  repo.write('cart.py', 'v = 3\n');
  s.run({ test_a: false });
  const j = repo.kerb(['green', '--json']).json.green;
  assert.equal(j.state, want);
  assert.deepEqual(j.changed_since, ['cart.py']);
  const text = repo.kerb(['green']).stdout;
  assert.match(text, new RegExp(`passed at \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d \\(run \\S+\\) · ${want}`));
  assert.match(text, /changed since: cart\.py\n {2}restore: kerb restore st_\w+ --patch/);
});

test('GR2 and for a single test', () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n' } });
  const s = suite(repo);
  s.run({ test_a: true, test_b: false });
  const aGreen = records(repo.dir).filter((r) => r.type === 'end').pop().post_hash;
  repo.write('cart.py', 'v = 2\n');
  s.run({ test_a: false, test_b: true });
  assert.equal(repo.kerb(['green', '--test', 'test_a', '--json']).json.green.state, aGreen);
  assert.equal(repo.kerb(['green', '--test', 'pytest:tests/test_cart.py::test_b', '--json']).json.green.test, 'pytest:tests/test_cart.py::test_b');
  assert.equal(repo.kerb(['green', '--test', 'test_never', '--json']).json.green, null);
});

test('GR3 restore --patch writes a correct patch and changes nothing', () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n', 'old.py': 'x\n' } });
  const s = suite(repo);
  repo.write('new_at_green.py', 'kept\n');
  s.run({ test_a: true });
  const state = greenRuns(repo).pop().post_hash;
  repo.write('cart.py', 'v = 2\n');
  fs.rmSync(path.join(repo.dir, 'new_at_green.py'));
  repo.write('later.py', 'added later\n');
  const before = { cart: repo.read('cart.py'), index: fs.readFileSync(path.join(repo.dir, '.git/index')) };
  const r = repo.kerb(['restore', state.slice(0, 9), '--patch', '--json']).json;
  assert.equal(r.applied, false);
  assert.equal(repo.read('cart.py'), before.cart, 'nothing changed');
  assert.ok(fs.readFileSync(path.join(repo.dir, '.git/index')).equals(before.index));
  repo.git('apply', r.patch);
  assert.equal(repo.read('cart.py'), 'v = 1\n');
  assert.equal(repo.read('new_at_green.py'), 'kept\n');
  assert.equal(repo.exists('later.py'), false);
  assert.match(repo.kerb(['restore', state, '--patch']).stdout, /already match/);
});

test('GR4 --keep-except reverts only the culprit hunks of a finding', () => {
  const head = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const repo = makeRepo({ git: true, files: { 'session.py': `${head}\n`, 'other.py': 'o = 1\n' } });
  const s = suite(repo);
  s.run({ test_a: true });
  const good = greenRuns(repo).pop().post_hash;
  const lines = head.split('\n');
  lines[2] = 'line 2 EDITED (harmless)';
  lines[25] = 'line 25 BROKEN (the culprit)';
  repo.write('session.py', `${lines.join('\n')}\n`);
  repo.write('other.py', 'o = 2\n');
  s.run({ test_a: false });
  const bad = records(repo.dir).filter((r) => r.type === 'end').pop().post_hash;
  const g = readState(repo.dir, good);
  const b = readState(repo.dir, bad);
  const hunks = treeHunks(repo.dir, g.tree, b.tree, scopeSpecs(b)).hunks;
  assert.deepEqual(hunks.map((h) => h.id), ['other.py#0', 'session.py#0', 'session.py#1']);
  new Store(repo.dir).append([{ type: 'finding', id: '3b2e5a71c0', ts: Date.now(), kind: 'cause', test_id: 'pytest:tests/test_cart.py::test_a', good_state: good, bad_state: bad, culprit_hunks: ['session.py#1'], probes: 7, confidence: 'confirmed', reason_if_undetermined: null }]);
  repo.write('notes.md', 'unrelated edit after the run\n');
  const res = repo.kerb(['restore', good, '--keep-except', 'f:3b2e', '--json']);
  const r = res.json;
  assert.equal(res.code, 0, res.stdout + res.stderr);
  repo.git('apply', r.patch);
  const after = repo.read('session.py').split('\n');
  assert.equal(after[25], 'line 25', 'the culprit hunk is reverted');
  assert.equal(after[2], 'line 2 EDITED (harmless)', 'the other edits are kept');
  assert.equal(repo.read('other.py'), 'o = 2\n');
  assert.equal(repo.read('notes.md'), 'unrelated edit after the run\n');
});

test('GR5 --in-place is human-only', async () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n' } });
  const s = suite(repo);
  s.run({ test_a: true });
  const state = greenRuns(repo).pop().post_hash;
  const p = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: `kerb restore ${state} --in-place` }, tool_use_id: 'r1' };
  const out = JSON.parse(repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) }).stdout);
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /human_only · kerb restore --in-place is for the user/);
  const ok = { ...p, tool_use_id: 'r2', tool_input: { command: `kerb restore ${state} --patch` } };
  assert.equal(repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(ok) }).stdout, '', '--patch is fine for agents');
  repo.write('cart.py', 'v = 2\n');
  const r = repo.kerb(['restore', state, '--in-place'], { input: '' });
  assert.equal(r.code, 64);
  assert.equal(repo.read('cart.py'), 'v = 2\n');
});

test('GR6 --in-place backs up the current changes with git stash first', async () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n' } });
  const s = suite(repo);
  s.run({ test_a: true });
  const state = greenRuns(repo).pop().post_hash;
  repo.write('cart.py', 'v = 2\n');
  repo.write('scratch.py', 'work in progress\n');
  setHumanOverrideForTests(() => true);
  try { assert.equal((await inproc(repo, ['restore', state, '--in-place'])).code, 0); } finally { setHumanOverrideForTests(null); }
  assert.equal(repo.read('cart.py'), 'v = 1\n');
  assert.equal(repo.exists('scratch.py'), false, 'the state did not have it');
  assert.match(repo.git('stash', 'list'), /kerb restore backup before st_/);
  assert.match(repo.git('show', 'stash@{0}:cart.py'), /v = 2/);
});

test('GR7 non-materializable states are refused with a reason', () => {
  const repo = makeRepo({ git: true, files: { 'cart.py': 'v = 1\n' } });
  fs.writeFileSync(path.join(repo.dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 7));
  suite(repo).run({ test_a: true });
  const state = greenRuns(repo).pop().post_hash;
  const r = repo.kerb(['restore', state, '--patch']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /not materializable: it has a file over 5 MB/);
});

test('GR8 a restore stays within the state\'s scope', () => {
  const repo = makeRepo({ git: true, files: {
    'packages/a/package.json': '{}', 'packages/a/cart.js': 'a = 1\n', 'packages/b/package.json': '{}', 'packages/b/user.js': 'b = 1\n',
  } });
  const s = suite(repo);
  s.run({ test_a: true }, path.join(repo.dir, 'packages/a'));
  const state = greenRuns(repo).pop().post_hash;
  assert.equal(readState(repo.dir, state).scope, 'packages/a');
  repo.write('packages/a/cart.js', 'a = 2\n');
  repo.write('packages/b/user.js', 'b = 2\n');
  const r = repo.kerb(['restore', state, '--patch', '--json']).json;
  const text = fs.readFileSync(path.join(repo.dir, r.patch), 'utf8');
  assert.match(text, /packages\/a\/cart\.js/);
  assert.doesNotMatch(text, /packages\/b/);
});
