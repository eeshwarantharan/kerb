import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, records } from './helpers.js';
import { computeScope } from '../src/loop/scope.js';
import { hashWorkspace, setHashDelayForTests } from '../src/loop/workspace.js';
import { envStamp } from '../src/loop/envstamp.js';
import { mergeLayers } from '../src/bound/policy.js';
import { main } from '../src/cli/main.js';

const posix = process.platform !== 'win32';

function hasher(repo, git, policyOver = {}) {
  const policy = { ...mergeLayers([]), ...policyOver };
  return (cwd = repo.dir) => {
    const scope = computeScope(repo.dir, cwd, policy);
    const r = hashWorkspace({ root: repo.dir, git, policy, env: {} }, scope, 5000);
    assert.equal(r.skipped, null);
    return r.hash;
  };
}

for (const mode of ['git', 'walk']) {
  const git = mode === 'git';
  test(`W1 (${mode}) editing a file changes the hash; reverting restores it`, () => {
    const repo = makeRepo({ git, files: { 'src/a.js': 'one\n', 'README.md': 'x\n' } });
    const h = hasher(repo, git);
    const h0 = h();
    repo.write('src/a.js', 'two\n');
    const h1 = h();
    assert.notEqual(h1, h0);
    repo.write('src/a.js', 'one\n');
    assert.equal(h(), h0);
  });

  test(`W2 (${mode}) an edit with mtime restored still changes the hash`, () => {
    const repo = makeRepo({ git, files: { 'src/a.js': 'aaaa\n' } });
    const h = hasher(repo, git);
    const file = path.join(repo.dir, 'src/a.js');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    const h0 = h();
    fs.writeFileSync(file, 'bbbb\n');
    fs.utimesSync(file, old, old);
    assert.notEqual(h(), h0);
  });

  test(`W3 (${mode}) chmod +x changes the hash`, { skip: !posix }, () => {
    const repo = makeRepo({ git, files: { 'run.sh': 'echo\n' } });
    const h = hasher(repo, git);
    const h0 = h();
    fs.chmodSync(path.join(repo.dir, 'run.sh'), 0o755);
    assert.notEqual(h(), h0);
  });

  test(`W4 (${mode}) ignored files don't affect the hash`, () => {
    const files = { '.kerbignore': 'coverage/\n*.snap\n', 'src/a.js': 'a\n' };
    if (git) files['.gitignore'] = 'dist/\n';
    const repo = makeRepo({ git, files });
    const h = hasher(repo, git);
    const h0 = h();
    repo.write('coverage/lcov.info', 'x');
    repo.write('src/x.snap', 'y');
    if (git) repo.write('dist/bundle.js', 'z');
    assert.equal(h(), h0);
  });
}

test('W5 a non-git directory uses walk mode with the default skips', () => {
  const repo = makeRepo({ files: { 'src/a.js': 'a\n' } });
  const h = hasher(repo, false);
  const h0 = h();
  repo.write('node_modules/x/index.js', 'x');
  repo.write('.venv/lib/y.py', 'y');
  repo.write('.git/HEAD_NOT_A_REPO', 'z');
  assert.equal(h(), h0);
  repo.write('src/b.js', 'b');
  assert.notEqual(h(), h0);
});

test('W6 pre- and post-hash are recorded; a test writing an unignored file changes the post-hash', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'a\n' } });
  const r = repo.kerb(['run', '--class', 'check', '--', 'echo snap > out.snap; exit 1']);
  assert.equal(r.code, 1);
  const recs = records(repo.dir);
  const start = recs.find((x) => x.type === 'start');
  const end = recs.find((x) => x.type === 'end');
  assert.ok(start.pre_hash);
  assert.ok(end.post_hash);
  assert.notEqual(start.pre_hash, end.post_hash);
  assert.ok(start.env_stamp);
  assert.equal(start.scope, '.');
});

test('W7 kerb diff lists exactly the changed files, including across commits (git mode)', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' } });
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  repo.write('a.js', 'a2\n');
  repo.git('commit', '-qam', 'change a');
  repo.write('b.js', 'b2\n');
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  const ids = records(repo.dir).filter((x) => x.type === 'end').map((x) => x.id);
  const d = repo.kerb(['diff', '--json', ids[0], ids[1]]);
  assert.deepEqual(d.json.files, ['a.js', 'b.js']);
  assert.equal(d.json.same_fingerprint, true);
  // Commit b, then run clean: b is dirty in run 2 and committed in run 3 with the same content.
  repo.git('commit', '-qam', 'change b');
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  const ids2 = records(repo.dir).filter((x) => x.type === 'end').map((x) => x.id);
  const d2 = repo.kerb(['diff', '--json', ids2[1], ids2[2]]);
  assert.deepEqual(d2.json.files, []);
  const human = repo.kerb(['diff', ids[0], ids[1]]);
  assert.match(human.stdout, /2 files changed/);
});

test('W7 kerb diff in walk mode', () => {
  const repo = makeRepo({ files: { 'a.js': 'a\n', 'b.js': 'b\n' } });
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  repo.write('b.js', 'changed\n');
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  const ids = records(repo.dir).filter((x) => x.type === 'end').map((x) => x.id);
  assert.deepEqual(repo.kerb(['diff', '--json', ids[0], ids[1]]).json.files, ['b.js']);
});

test('W8 changing node_modules/.package-lock.json changes the env stamp', () => {
  const repo = makeRepo({ files: { 'package.json': '{}', 'node_modules/.package-lock.json': '{}' } });
  const s0 = envStamp({}, {}, [repo.dir]);
  const f = path.join(repo.dir, 'node_modules/.package-lock.json');
  fs.writeFileSync(f, '{"x":1}');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(f, later, later);
  assert.notEqual(envStamp({}, {}, [repo.dir]), s0);
  assert.notEqual(envStamp({ NODE_ENV: 'test' }, {}, [repo.dir]), envStamp({}, {}, [repo.dir]));
});

test('W9 a 5,000-file repo with a warm cache hashes quickly', () => {
  const files = {};
  for (let i = 0; i < 5000; i++) files[`src/d${i % 50}/f${i}.js`] = `export const v${i} = ${i};\n`;
  for (const git of [false, true]) {
    const repo = makeRepo({ git, files });
    const policy = mergeLayers([]);
    const scope = computeScope(repo.dir, repo.dir, policy);
    hashWorkspace({ root: repo.dir, git, policy, env: {} }, scope, 30_000); // warm
    const times = [];
    for (let i = 0; i < 3; i++) {
      const r = hashWorkspace({ root: repo.dir, git, policy, env: {} }, scope, 30_000);
      times.push(r.ms);
    }
    const best = Math.min(...times);
    const limit = process.env.CI ? 300 : 100;
    assert.ok(best < limit, `${git ? 'git' : 'walk'} mode took ${best}ms (limit ${limit})`);
  }
});

function monorepo(git) {
  return makeRepo({
    git,
    files: {
      'package.json': '{"workspaces":["packages/*"]}',
      'package-lock.json': '{}',
      'tsconfig.json': '{}',
      'packages/a/package.json': '{}',
      'packages/a/index.js': 'a\n',
      'packages/b/package.json': '{}',
      'packages/b/x.js': 'b\n',
    },
  });
}

for (const git of [true, false]) {
  const mode = git ? 'git' : 'walk';
  test(`W10 (${mode}) monorepo: editing another package doesn't change the hash`, () => {
    const repo = monorepo(git);
    const h = hasher(repo, git);
    const cwd = path.join(repo.dir, 'packages/a');
    const h0 = h(cwd);
    repo.write('packages/b/x.js', 'b2\n');
    assert.equal(h(cwd), h0);
    repo.write('packages/a/index.js', 'a2\n');
    assert.notEqual(h(cwd), h0);
  });

  test(`W11 (${mode}) monorepo: editing the root lockfile or tsconfig does change it`, () => {
    const repo = monorepo(git);
    const h = hasher(repo, git);
    const cwd = path.join(repo.dir, 'packages/a');
    const h0 = h(cwd);
    repo.write('package-lock.json', '{"v":2}');
    const h1 = h(cwd);
    assert.notEqual(h1, h0);
    repo.write('tsconfig.json', '{"strict":true}');
    assert.notEqual(h(cwd), h1);
  });

  test(`W12 (${mode}) hash_scope "repo" makes other packages count`, () => {
    const repo = monorepo(git);
    const h = hasher(repo, git, { hash_scope: 'repo' });
    const cwd = path.join(repo.dir, 'packages/a');
    const h0 = h(cwd);
    repo.write('packages/b/x.js', 'b2\n');
    assert.notEqual(h(cwd), h0);
  });

  test(`W13 (${mode}) a command at the repo root uses the whole repo`, () => {
    const repo = monorepo(git);
    const policy = mergeLayers([]);
    assert.equal(computeScope(repo.dir, repo.dir, policy).whole, true);
    const h = hasher(repo, git);
    const h0 = h();
    repo.write('packages/b/x.js', 'b3\n');
    assert.notEqual(h(), h0);
  });
}

test('W14 100,000-file git repo with fsmonitor hashes under 300 ms warm', { skip: !process.env.KERB_TEST_PERF && 'set KERB_TEST_PERF=1 (performance CI job)' }, async () => {
  const { makeBigRepo } = await import('./perf-helpers.js');
  const repo = makeBigRepo(100_000);
  const policy = mergeLayers([]);
  const scope = computeScope(repo.dir, repo.dir, policy);
  const times = [];
  for (let i = 0; i < 5; i++) times.push(hashWorkspace({ root: repo.dir, git: true, policy, env: {} }, scope, 60_000).ms);
  const warm = Math.min(...times.slice(2));
  try { execFileSync('git', ['-C', repo.dir, 'fsmonitor--daemon', 'stop'], { stdio: 'ignore' }); } catch { /* not running */ }
  fs.rmSync(repo.dir, { recursive: true, force: true });
  assert.ok(warm < 300, `took ${warm}ms warm (all: ${times.join(', ')})`);
});

test('W15 hash budget exceeded → command allowed, loop checks skipped and recorded', async () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'a\n' } });
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb', 'config.json'), JSON.stringify({ hash_budget_ms: 20 }));
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  setHashDelayForTests(60);
  const sink = { write() {}, isTTY: false };
  try {
    const code = await main(['run', '--class', 'check', '--', `echo ran >> ${path.join(repo.dir, 'side.txt')}; exit 1`], { stdout: sink, stderr: sink, cwd: repo.dir });
    assert.equal(code, 1);
    const code2 = await main(['run', '--class', 'check', '--', `echo ran >> ${path.join(repo.dir, 'side.txt')}; exit 1`], { stdout: sink, stderr: sink, cwd: repo.dir });
    assert.equal(code2, 1, 'second identical run allowed because loop checks were skipped');
  } finally {
    setHashDelayForTests(0);
    process.env.HOME = oldHome;
  }
  assert.equal(repo.read('side.txt'), 'ran\nran\n');
  const ends = records(repo.dir).filter((x) => x.type === 'end');
  assert.ok(ends.every((e) => e.loop_skipped === 'hash_budget'));
});

test('W16 a commit changes the hash; git stash and pop back to the same content restores it', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': 'a\n', 'b.js': 'b\n' } });
  const h = hasher(repo, true);
  repo.write('a.js', 'edited\n');
  const dirty = h();
  repo.git('stash', '-q');
  assert.notEqual(h(), dirty);
  repo.git('stash', 'pop', '-q');
  assert.equal(h(), dirty);
  const before = h();
  repo.git('commit', '-qam', 'commit a');
  assert.notEqual(h(), before);
});
