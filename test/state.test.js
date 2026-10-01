// ST · State model (KERB-V2 4, tests ST1–ST14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, records, tmpDir, runKerbAsync, baseEnv } from './helpers.js';
import { computeScope } from '../src/loop/scope.js';
import { hashWorkspace } from '../src/loop/workspace.js';
import { mergeLayers } from '../src/bound/policy.js';
import { readState, keepState } from '../src/state/keep.js';
import { keptStates, gcStates, KEEP_PER_KEY } from '../src/state/gc.js';
import { worktreeAt, removeWorktree, writePatch } from '../src/state/materialize.js';

const policy = mergeLayers([]);
const stateOf = (repo, git = true, extra = {}) => hashWorkspace({ root: repo.dir, git, policy, env: {}, ...extra }, computeScope(repo.dir, repo.dir, policy), 30_000);
const ends = (repo) => records(repo.dir).filter((x) => x.type === 'end');
const check = (repo, cmd = 'exit 1') => repo.kerb(['run', '--class', 'check', '--', cmd]);
const git = (dir, ...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...baseEnv(), GIT_CONFIG_NOSYSTEM: '1' } });

function fixedRepo() {
  const dir = tmpDir('kerb-st1-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'a\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'b\n');
  const env = { ...baseEnv(), GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@x', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@x', GIT_AUTHOR_DATE: '@1700000000 +0000', GIT_COMMITTER_DATE: '@1700000000 +0000' };
  for (const a of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-qm', 'fixture']]) execFileSync('git', a, { cwd: dir, env });
  fs.writeFileSync(path.join(dir, 'src/b.js'), 'b2\n');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n\n');
  return { dir };
}

test('ST1 same content → same state id across runs and machines (fixture repo)', () => {
  const a = fixedRepo();
  const b = fixedRepo();
  const ha = stateOf(a).hash;
  assert.match(ha, /^st_[0-9a-f]{16}$/);
  assert.equal(stateOf(a).hash, ha, 'stable across runs');
  assert.equal(stateOf(b).hash, ha, 'same in a second clone with the same content');
  assert.equal(stateOf(a).snapshot.tree, stateOf(b).snapshot.tree);
});

test('ST2 state ids are what the v1 rules compare (W1–W16 run on them)', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  check(repo);
  const r = check(repo);
  assert.match(r.stderr, /identical_retry/);
  const [end] = ends(repo);
  assert.match(end.post_hash, /^st_/);
  assert.equal(records(repo.dir).find((x) => x.type === 'start').pre_hash, end.post_hash);
});

test('ST3 untracked non-ignored files are in the snapshot; ignored files are not', () => {
  const repo = makeRepo({ git: true, files: { '.gitignore': 'dist/\n', '.kerbignore': 'tmp/\n', 'a.js': '1\n' } });
  repo.write('new.js', 'new\n');
  repo.write('dist/out.js', 'built\n');
  repo.write('tmp/scratch.txt', 'x\n');
  check(repo);
  const st = readState(repo.dir, ends(repo)[0].post_hash);
  const files = repo.git('ls-tree', '-r', '--name-only', st.tree).trim().split('\n');
  assert.ok(files.includes('new.js'));
  assert.ok(!files.includes('dist/out.js'));
  assert.ok(!files.includes('tmp/scratch.txt'));
  assert.ok(!files.some((f) => f.startsWith('.kerb/')));
});

test('ST4 the snapshot does not modify the real index', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n', 'b.js': '2\n' } });
  repo.write('a.js', 'changed\n');
  repo.write('c.js', 'untracked\n');
  repo.git('add', 'b.js');
  const index = path.join(repo.dir, '.git/index');
  const before = fs.readFileSync(index);
  const s = stateOf(repo, true, { store: true });
  keepState(repo.dir, s.snapshot, Date.now());
  check(repo);
  assert.ok(fs.readFileSync(index).equals(before), 'byte-identical .git/index');
  assert.deepEqual(fs.readdirSync(path.join(repo.dir, '.kerb/tmp')), [], 'temporary indexes removed');
});

test('ST5 concurrent snapshots do not collide', async () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  repo.write('a.js', 'dirty\n');
  repo.write('u.js', 'untracked\n');
  const runs = Array.from({ length: 10 }, (_, i) => runKerbAsync(['run', '--class', 'check', '--key', `k${i}`, '--', 'exit 1'], { cwd: repo.dir, env: repo.env }));
  await Promise.all(runs.map((r) => r.done));
  const e = ends(repo);
  assert.equal(e.length, 10);
  assert.equal(new Set(e.map((x) => x.post_hash)).size, 1, 'every run saw the same state');
  assert.equal(records(repo.dir).filter((x) => x.type === 'state').length >= 1, true);
  assert.deepEqual(fs.readdirSync(path.join(repo.dir, '.kerb/tmp')), []);
});

test('ST6 kept states get refs under refs/kerb/states/', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  repo.write('a.js', '2\n');
  check(repo);
  const id = ends(repo)[0].post_hash;
  const rec = records(repo.dir).find((x) => x.type === 'state');
  assert.equal(rec.id, id);
  assert.equal(repo.git('rev-parse', `refs/kerb/states/${id}`).trim(), rec.commit);
  assert.equal(repo.git('rev-parse', `${rec.commit}^{tree}`).trim(), rec.snapshot_tree);
  assert.match(repo.git('log', '-1', '--format=%s', rec.commit), new RegExp(`kerb state ${id}`));
  assert.equal(repo.git('rev-parse', `${rec.commit}^`).trim(), repo.git('rev-parse', 'HEAD').trim(), 'parent is HEAD');
});

test('ST7 retention keeps the right states; kerb gc removes the others', () => {
  const day = 86_400_000;
  const now = Date.parse('2026-10-01T00:00:00Z');
  const recs = [];
  const run = (id, key, st, exit, ts) => recs.push({ type: 'start', id, ts, key, class: 'check' }, { type: 'end', id, ts, exit, class_result: exit === 0 ? 'ok' : 'failure', post_hash: st, key, class: 'check' });
  for (let i = 0; i < 25; i++) run(`r${i}`, 'k', `st_${String(i).padStart(16, '0')}`, 1, now - day + i);
  run('g1', 'other', 'st_aaaaaaaaaaaaaaa1', 0, now - 10 * day);
  run('g2', 'other2', 'st_aaaaaaaaaaaaaaa2', 0, now - 20 * day);
  for (let i = 0; i < KEEP_PER_KEY; i++) run(`o${i}`, 'other2', `st_bbbbbbbbbbbbbb${String(i).padStart(2, '0')}`, 1, now - 19 * day + i);
  recs.push({ type: 'fix', id: 'f1', from_state: 'st_0000000000000000', to_state: 'st_cccccccccccccccc' });
  const keep = keptStates(recs, now);
  for (let i = 5; i < 25; i++) assert.ok(keep.has(`st_${String(i).padStart(16, '0')}`), `last 20 of k: ${i}`);
  assert.ok(!keep.has('st_0000000000000003'), 'older than the last 20');
  assert.ok(keep.has('st_0000000000000000'), 'referenced by a fix');
  assert.ok(keep.has('st_aaaaaaaaaaaaaaa1'), 'green within 14 days');
  assert.ok(!keep.has('st_aaaaaaaaaaaaaaa2'), 'green 20 days ago and not among the last 20');

  const repo = makeRepo({ git: true, files: { 'a.js': '0\n' } });
  for (const v of ['1', '2', '3']) { repo.write('a.js', `${v}\n`); check(repo); }
  const ids = ends(repo).map((e) => e.post_hash);
  assert.equal(repo.git('for-each-ref', '--format=%(refname)', 'refs/kerb/states/').trim().split('\n').length, 3);
  const onlyLast = records(repo.dir).filter((r) => (r.type !== 'start' && r.type !== 'end') || r.id === ends(repo)[2].id);
  const r = gcStates(repo.dir, onlyLast, Date.now(), { git: true });
  assert.deepEqual(r.removed.sort(), ids.slice(0, 2).sort());
  assert.equal(repo.git('for-each-ref', '--format=%(refname)', 'refs/kerb/states/').trim(), `refs/kerb/states/${ids[2]}`);
  assert.equal(readState(repo.dir, ids[0]), null);
  assert.ok(readState(repo.dir, ids[2]));
  assert.equal(repo.kerb(['gc', '--json']).json.removed.length, 0, 'the CLI keeps all three (each is among its key\'s last 20)');
});

test('ST8 a worktree at a state reproduces its files exactly and leaves the working tree alone', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n', 'node_modules/dep/index.js': 'dep\n', '.gitignore': 'node_modules/\n' } });
  repo.write('a.js', 'state\n');
  repo.write('new.js', 'untracked at the state\n');
  check(repo);
  const id = ends(repo)[0].post_hash;
  repo.write('a.js', 'later\n');
  fs.rmSync(path.join(repo.dir, 'new.js'));
  const before = fs.readFileSync(path.join(repo.dir, 'a.js'), 'utf8');
  const wt = worktreeAt(repo.dir, id, 'job1');
  assert.equal(wt.ok, true, wt.reason);
  assert.equal(fs.readFileSync(path.join(wt.dir, 'a.js'), 'utf8'), 'state\n');
  assert.equal(fs.readFileSync(path.join(wt.dir, 'new.js'), 'utf8'), 'untracked at the state\n');
  assert.ok(fs.lstatSync(path.join(wt.dir, 'node_modules')).isSymbolicLink(), 'dependencies linked');
  assert.equal(fs.readFileSync(path.join(repo.dir, 'a.js'), 'utf8'), before);
  assert.ok(!repo.exists('new.js'));
  removeWorktree(repo.dir, wt.dir);
  assert.ok(!fs.existsSync(wt.dir));
  assert.ok(repo.exists('node_modules/dep/index.js'), 'removing the worktree never deletes through the link');
  assert.equal(repo.git('worktree', 'list').trim().split('\n').length, 1);
  assert.equal(worktreeAt(repo.dir, id, 'job2', { envStamp: 'different' }).reason, 'dependencies changed');
});

test('ST9 a patch from the current state to a kept state applies cleanly and yields it', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n', 'b.js': 'b\n' } });
  repo.write('a.js', 'green\n');
  check(repo, 'true');
  const target = readState(repo.dir, ends(repo)[0].post_hash);
  repo.write('a.js', 'red\n');
  repo.write('c.js', 'added later\n');
  fs.rmSync(path.join(repo.dir, 'b.js'));
  const cur = stateOf(repo, true, { store: true });
  const index = fs.readFileSync(path.join(repo.dir, '.git/index'));
  const p = writePatch(repo.dir, cur.snapshot, target, path.join(repo.dir, '.kerb/patches/t.patch'));
  assert.equal(p.ok, true, p.reason);
  assert.equal(repo.read('a.js'), 'red\n', 'writing the patch changes nothing');
  assert.ok(fs.readFileSync(path.join(repo.dir, '.git/index')).equals(index));
  repo.git('apply', '--check', p.path);
  repo.git('apply', p.path);
  assert.equal(stateOf(repo).snapshot.tree, target.tree, 'applying it yields the state');
});

test('ST10 files over 5 MB make a state not materializable', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  fs.writeFileSync(path.join(repo.dir, 'big.bin'), Buffer.alloc(6 * 1024 * 1024, 1));
  check(repo);
  const rec = records(repo.dir).find((x) => x.type === 'state');
  assert.equal(rec.materializable, false);
  assert.match(worktreeAt(repo.dir, rec.id, 'j').reason, /not materializable/);
  assert.throws(() => repo.git('cat-file', '-s', `${rec.snapshot_tree}:big.bin`), /could not get object info/, 'the big blob was not stored');
});

test('ST11 walk mode stores and restores blobs', () => {
  const repo = makeRepo({ files: { 'a.js': 'walk a\n', 'src/b.js': 'walk b\n' } });
  fs.chmodSync(path.join(repo.dir, 'a.js'), 0o755);
  check(repo);
  const id = ends(repo)[0].post_hash;
  const st = readState(repo.dir, id);
  assert.equal(st.mode, 'walk');
  repo.write('a.js', 'changed\n');
  const wt = worktreeAt(repo.dir, id, 'walkjob');
  assert.equal(wt.ok, true, wt.reason);
  assert.equal(fs.readFileSync(path.join(wt.dir, 'a.js'), 'utf8'), 'walk a\n');
  assert.equal(fs.readFileSync(path.join(wt.dir, 'src/b.js'), 'utf8'), 'walk b\n');
  if (process.platform !== 'win32') assert.ok(fs.statSync(path.join(wt.dir, 'a.js')).mode & 0o100);
  removeWorktree(repo.dir, wt.dir);
  assert.ok(!fs.existsSync(wt.dir));
});

test('ST12 doctor warns about remotes that would push refs/kerb', () => {
  const repo = makeRepo({ git: true });
  repo.git('remote', 'add', 'backup', 'https://example.invalid/r.git');
  repo.git('config', 'remote.backup.mirror', 'true');
  repo.git('remote', 'add', 'all', 'https://example.invalid/s.git');
  repo.git('config', 'remote.all.push', '+refs/*:refs/*');
  const warns = repo.kerb(['doctor', '--json']).json.checks.filter((c) => c.level === 'warn').map((c) => c.text);
  assert.ok(warns.some((w) => /remote backup is a mirror/.test(w)));
  assert.ok(warns.some((w) => /remote all pushes \+refs\/\*:refs\/\*/.test(w)));
});

test('ST13 a snapshot over budget → no state, loop checks skipped', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' }, config: { hash_budget_ms: 10 } });
  for (let i = 0; i < 300; i++) repo.write(`u/f${i}.js`, `${i}\n`);
  const tiny = hashWorkspace({ root: repo.dir, git: true, policy, env: {} }, computeScope(repo.dir, repo.dir, policy), 1);
  assert.equal(tiny.hash, null);
  assert.equal(tiny.skipped, 'hash_budget');
});

test('ST14 a default git push never sends refs/kerb/*; a mirror push gets a note', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const bare = tmpDir('kerb-bare-');
  git(bare, 'init', '-q', '--bare');
  repo.git('remote', 'add', 'origin', bare);
  repo.write('a.js', 'dirty\n');
  check(repo);
  assert.ok(repo.git('for-each-ref', 'refs/kerb/').trim());
  repo.git('push', '-q', 'origin', 'main');
  repo.git('push', '-q', '--all', 'origin');
  repo.git('push', '-q', '--tags', 'origin');
  assert.doesNotMatch(git(bare, 'for-each-ref'), /refs\/kerb/);
  const p = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'git push --mirror origin' }, tool_use_id: 'm1' };
  const out = JSON.parse(repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) }).stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /git push --mirror also pushes Kerb's local state refs/);
});

test('a same-size edit right after a snapshot is always seen (racy index copy)', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'v00\n' } });
  let prev = stateOf(repo).hash;
  for (let i = 1; i <= 15; i++) {
    repo.write('a.js', `v${String(i).padStart(2, '0')}\n`);
    const h = stateOf(repo).hash;
    assert.notEqual(h, prev, `edit ${i} seen`);
    prev = h;
  }
});

test('the state cache answers an untouched retry and never hides a later edit', async () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'aaaa\n' } });
  repo.write('a.js', 'bbbb\n');
  await new Promise((r) => setTimeout(r, 2100)); // older than the racy window
  const first = stateOf(repo);
  assert.ok(fs.existsSync(path.join(repo.dir, '.kerb/state-cache.json')), 'stored once the files are old enough');
  const again = stateOf(repo);
  assert.equal(again.hash, first.hash);
  assert.equal(again.snapshot.tree, first.snapshot.tree);
  repo.write('a.js', 'cccc\n'); // same size
  assert.notEqual(stateOf(repo).hash, first.hash);
  repo.write('a.js', 'bbbb\n');
  assert.equal(stateOf(repo).hash, first.hash, 'same content, same state');
});
