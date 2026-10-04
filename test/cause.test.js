// CA · Cause isolation (KERB-V2 8.2, tests CA1–CA12), on seeded-bug repos with Node's runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, asHome } from './helpers.js';
import { listJobs, enqueue } from '../src/worker/queue.js';

const CMD = 'node --test test/app.test.js';
const mod = (name, body) => `// ${name}\n${body}\nmodule.exports = { ${name} };\n`;
const TEST = [
  "const { it } = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const fs = require('node:fs');",
  "const { logout } = require('../src/session.js');",
  "const { total } = require('../src/cart.js');",
  "it('logout clears session', () => { assert.equal(logout({ user: 'a' }).user, null); });",
  "it('adds totals', () => { assert.equal(total([1, 2]), 3); });",
  "it('no flag file', () => { assert.equal(fs.existsSync(require('node:path').join(require('node:os').homedir(), 'flag')), false); });",
].join('\n');

function seeded(config = {}, testSource = TEST) {
  const repo = makeRepo({ git: true, config: { cause: 'on', worker: 'manual', ...config }, files: {
    'src/session.js': mod('logout', 'function logout(s) {\n  s.user = null;\n  return s;\n}'),
    'src/cart.js': mod('total', 'function total(a) {\n  return a.reduce((x, y) => x + y, 0);\n}'),
    'src/price.js': mod('price', 'function price(p) {\n  return p;\n}'),
    'src/util.js': mod('noop', 'function noop() {}'),
    'src/old.js': 'module.exports = 0;\n',
    'test/app.test.js': `${testSource}\n`,
  } });
  const run = () => repo.kerb(['run', '--', CMD]);
  return { repo, run };
}

/** Five harmless edits (one adds a file, one deletes one) plus whatever `extra` does. */
function sixEdits(repo, extra) {
  repo.write('src/cart.js', mod('total', 'function total(a) {\n  // sum\n  return a.reduce((x, y) => x + y, 0);\n}'));
  repo.write('src/price.js', mod('price', 'function price(p) {\n  return Math.round(p);\n}'));
  repo.write('src/util.js', mod('noop', 'function noop() { return undefined; }'));
  repo.write('src/new.js', 'module.exports = 1;\n');
  fs.rmSync(path.join(repo.dir, 'src/old.js'));
  extra();
}
const breakLogout = (repo) => repo.write('src/session.js', mod('logout', 'function logout(s) {\n  s.user = s.user;\n  return s;\n}'));
const findings = (repo) => records(repo.dir).filter((r) => r.type === 'finding');
const work = (repo) => repo.kerb(['worker', '--once', '--json']).json;
const tree = (repo) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === '.kerb') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(repo.dir, p)] = fs.readFileSync(p, 'utf8'); } };
  walk(repo.dir);
  return out;
};

test('CA1 a single culprit hunk among six; CA10 never applied; WK5 the working tree is untouched; WK6 worktrees removed', () => {
  const { repo, run } = seeded();
  run();
  sixEdits(repo, () => breakLogout(repo));
  assert.equal(run().code, 1);
  assert.equal(listJobs(repo.dir).filter((j) => j.kind === 'cause').length, 1);
  const before = tree(repo);
  const index = fs.readFileSync(path.join(repo.dir, '.git/index'));
  assert.equal(work(repo).ran, 1);
  const [f] = findings(repo);
  assert.equal(f.confidence, 'confirmed');
  assert.deepEqual(f.culprit_hunks, ['src/session.js#0']);
  assert.deepEqual(f.locations, ['src/session.js:3']);
  assert.equal(f.hunk_count, 6);
  assert.ok(f.probes <= 12, `${f.probes} probes`);
  assert.deepEqual(tree(repo), before, 'nothing applied to the working tree');
  assert.ok(fs.readFileSync(path.join(repo.dir, '.git/index')).equals(index));
  assert.deepEqual(fs.readdirSync(path.join(repo.dir, '.kerb/worktrees')), []);
  assert.equal(repo.git('worktree', 'list').trim().split('\n').length, 1);
});

test('CA2 a pair of interdependent hunks', () => {
  const { repo, run } = seeded({ cause_max_probes: 30 });
  run();
  sixEdits(repo, () => {
    repo.write('src/cart.js', mod('total', 'const { FLAG } = require("./util.js");\nfunction total(a) {\n  return a.reduce((x, y) => x + y, 0) + (FLAG ? 1 : 0);\n}'));
    repo.write('src/util.js', 'function noop() {}\nconst FLAG = true;\nmodule.exports = { noop, FLAG };\n');
  });
  run();
  work(repo);
  const [f] = findings(repo);
  assert.equal(f.confidence, 'confirmed', f.reason_if_undetermined);
  assert.equal(f.test_id, 'node:test/app.test.js::adds totals');
  assert.deepEqual([...f.culprit_hunks].sort(), ['src/cart.js#0', 'src/util.js#0']);
});

test('CA3 not reproducible in isolation → undetermined', () => {
  const { repo, run } = seeded();
  run();
  repo.write('src/util.js', mod('noop', 'function noop() { return 1; }'));
  fs.writeFileSync(path.join(repo.home, 'flag'), 'x'); // the failure comes from outside the repo
  run();
  fs.rmSync(path.join(repo.home, 'flag'));
  work(repo);
  const [f] = findings(repo);
  assert.equal(f.confidence, 'undetermined');
  assert.equal(f.reason_if_undetermined, 'not reproducible in isolation');
});

test('CA4 a flaky test does not trigger isolation', () => {
  const { repo, run } = seeded();
  run();
  fs.writeFileSync(path.join(repo.home, 'flag'), 'x');
  run(); // the same files: "no flag file" passed and failed on this state, so it is flaky
  repo.write('src/util.js', mod('noop', 'function noop() { return 2; }'));
  run();
  assert.equal(listJobs(repo.dir).filter((j) => j.kind === 'cause').length, 0);
});

test('CA5 dependencies changed → undetermined', () => {
  const { repo, run } = seeded();
  repo.write('node_modules/.package-lock.json', '{}');
  repo.write('.gitignore', 'node_modules/\n');
  run();
  sixEdits(repo, () => breakLogout(repo));
  run();
  repo.write('node_modules/.package-lock.json', '{"changed":true}');
  const later = new Date(Date.now() + 10_000);
  fs.utimesSync(path.join(repo.dir, 'node_modules/.package-lock.json'), later, later);
  work(repo);
  assert.equal(findings(repo)[0].reason_if_undetermined, 'dependencies changed');
});

test('CA6 budget exhausted → undetermined, with the partial set labelled', () => {
  const { repo, run } = seeded({ cause_max_probes: 4 });
  run();
  sixEdits(repo, () => breakLogout(repo));
  run();
  work(repo);
  const [f] = findings(repo);
  assert.equal(f.confidence, 'undetermined');
  assert.match(f.reason_if_undetermined, /^interdependent changes \(budget exhausted; the smallest failing set found so far\)$/);
  assert.equal(f.partial, true);
  assert.ok(f.culprit_hunks.length >= 1);
  const ctx = repo.kerb(['run', '--', 'true']).stderr;
  assert.match(ctx, /kerb: cause · couldn't isolate why "logout clears session" broke: interdependent changes/);
  assert.match(ctx, /smallest failing set found \(not confirmed\): /);
});

test('CA7 a confirmation probe is required: two independent culprits do not confirm as one', () => {
  const { repo, run } = seeded({ cause_max_probes: 30 });
  run();
  sixEdits(repo, () => {
    breakLogout(repo);
    repo.write('test/app.test.js', `${TEST.replace("logout({ user: 'a' }).user, null", "logout({ user: 'a' }).user, null); assert.ok(require('../src/new.js') === 0")}\n`);
  });
  run();
  work(repo);
  const [f] = findings(repo);
  if (f.confidence === 'confirmed') {
    // ddmin may find both at once; then reverting them must pass, which the probe checked.
    assert.ok(f.culprit_hunks.length >= 2, JSON.stringify(f));
  } else assert.match(f.reason_if_undetermined, /did not confirm|interdependent/);
});

test('CA8 probe results are cached by tree id', () => {
  const { repo, run } = seeded();
  run();
  sixEdits(repo, () => breakLogout(repo));
  run();
  work(repo);
  const first = findings(repo)[0];
  const job = listJobs(repo.dir).find((j) => j.kind === 'cause');
  asHome(repo.home, () => enqueue(repo.dir, 'cause', job.payload));
  work(repo);
  const second = findings(repo)[1];
  assert.equal(second.confidence, 'confirmed');
  assert.ok(second.probes < first.probes, `cached search: ${second.probes} < ${first.probes}`);
  assert.ok(fs.existsSync(path.join(repo.dir, '.kerb/probe-cache.json')));
});

test('CA9 the finding is delivered at the next injection point, once', () => {
  const { repo, run } = seeded();
  run();
  sixEdits(repo, () => breakLogout(repo));
  run();
  work(repo);
  const p = (id, command) => ({ session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command }, tool_use_id: id });
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('a', 'ls')) });
  const out = JSON.parse(repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...p('a', 'ls'), tool_response: { stdout: 'x', stderr: '', interrupted: false } }) }).stdout);
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^kerb: cause · "logout clears session" broke at attempt 1\n {6}culprit: src\/session\.js:3 \(1 of 6 hunks\) · confirmed by \d+ probes\n {6}next: revert just that hunk to restore green \(kerb restore st_\w+ --keep-except f:\w+ --patch\); your other edits are kept/);
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('b', 'ls')) });
  assert.equal(repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...p('b', 'ls'), tool_response: { stdout: 'x', stderr: '', interrupted: false } }) }).stdout, '', 'once');
  // The suggested restore reverts exactly the culprit.
  const cmd = /\(kerb restore (\S+) --keep-except (\S+) --patch\)/.exec(text);
  const r = repo.kerb(['restore', cmd[1], '--keep-except', cmd[2], '--json']).json;
  repo.git('apply', r.patch);
  assert.match(repo.read('src/session.js'), /s\.user = null/);
  assert.match(repo.read('src/cart.js'), /\/\/ sum/, 'other edits kept');
  assert.equal(run().code, 0);
});

test('CA11 off for tests until a person enables it; the recap mentions it once', () => {
  const { repo, run } = seeded({ cause: 'off' });
  run();
  sixEdits(repo, () => breakLogout(repo));
  run();
  assert.equal(listJobs(repo.dir).length, 0);
  const stop = () => repo.kerb(['hook', 'claude', 'stop'], { input: JSON.stringify({ session_id: records(repo.dir).find((r) => r.session).session, cwd: repo.dir }) }).stdout;
  assert.match(stop(), /Kerb could have isolated which change broke \\"logout clears session\\"; to let it, run kerb config set cause on/);
  assert.doesNotMatch(stop(), /could have isolated/);
});

test('CA12 added and deleted files are single hunks', () => {
  // The test already checks that src/new.js doesn't exist; adding it (a whole-file hunk) breaks it.
  const { repo, run } = seeded({}, TEST.replace("logout({ user: 'a' }).user, null", "logout({ user: 'a' }).user, null); assert.ok(!require('node:fs').existsSync(require('node:path').join(__dirname, '../src/new.js'))"));
  run();
  sixEdits(repo, () => {});
  run();
  work(repo);
  const [f] = findings(repo);
  assert.equal(f.confidence, 'confirmed', f.reason_if_undetermined);
  assert.deepEqual(f.culprit_hunks, ['src/new.js#0']);
  assert.deepEqual(f.locations, ['src/new.js']);
});

const hasPytest = (await import('node:child_process')).spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;
test('CA13 runners that name only failures (pytest -q) still start isolation, and it finds the culprit', { skip: !hasPytest && 'pytest not installed' }, () => {
  const pad = '#\n'.repeat(7);
  const repo = makeRepo({ git: true, config: { cause: 'on', worker: 'manual' }, files: {
    'shop.py': `def total(xs):\n    return sum(xs)\n${pad}\ndef label(x):\n    return str(x)\n`,
    'test_shop.py': 'from shop import total, label\n\n\ndef test_total():\n    assert total([1, 2]) == 3\n\n\ndef test_label():\n    assert label(1) == "1"\n',
  } });
  const cmd = 'python3 -m pytest -q -p no:cacheprovider';
  repo.kerb(['run', '--', cmd]);
  const green = records(repo.dir).filter((r) => r.type === 'test_result');
  assert.equal(green.length, 0, 'the green run names no test');
  repo.write('shop.py', `def total(xs):\n    return sum(xs) + 1\n${pad}\ndef label(x):\n    return str(x).strip()\n`);
  repo.kerb(['run', '--', cmd]);
  assert.deepEqual(listJobs(repo.dir).filter((j) => j.kind === 'cause').map((j) => j.payload.test_id), ['pytest:test_shop.py::test_total']);
  repo.kerb(['worker', '--once']);
  const f = records(repo.dir).filter((r) => r.type === 'finding').pop();
  assert.equal(f.confidence, 'confirmed');
  assert.deepEqual(f.locations, ['shop.py:2']);
});
