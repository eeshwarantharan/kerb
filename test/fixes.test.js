// FX · Proven fixes (KERB-V2 7.6) and NS · Notes sharing (7.7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo, records, tmpDir, baseEnv, inproc } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { latestFixes } from '../src/insight/fixes.js';

const CMD = 'node --test test/app.test.js';
const mod = (name, body) => `${body}\nmodule.exports = { ${name} };\n`;
const TESTS = {
  a: "it('logout clears session', () => { assert.equal(logout({ user: 'a' }).user, null); });",
  b: "it('login keeps user', () => { assert.equal(login('b').user, 'b'); });",
};
const testFile = (which = ['a', 'b']) => [
  "const { it } = require('node:test');", "const assert = require('node:assert/strict');",
  "const { logout } = require('../src/session.js');", "const { login } = require('../src/login.js');", ...which.map((w) => TESTS[w]),
].join('\n');
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };

function project(config = {}) {
  const repo = makeRepo({ git: true, config: { worker: 'manual', ...config }, files: {
    'src/session.js': mod('logout', 'function logout(s) {\n  s.user = null;\n  return s;\n}'),
    'src/login.js': mod('login', 'function login(u) {\n  return { user: u };\n}'),
    'src/notes.md': 'notes\n',
    'test/app.test.js': `${testFile()}\n`,
  } });
  const run = (env) => repo.kerb(['run', '--', CMD], { env: { ...GIT_ENV, ...(env || {}) } });
  return { repo, run };
}
const breakLogout = (repo, v = 'x') => repo.write('src/session.js', mod('logout', `function logout(s) {\n  s.user = s.user; // ${v}\n  return s;\n}`));
const fixLogout = (repo) => repo.write('src/session.js', mod('logout', 'function logout(s) {\n  s.user = null;\n  return s;\n}'));
const fixes = (repo) => latestFixes(records(repo.dir));
const hintOf = (r) => (/^kerb: hint · (.+)$/m.exec(r.stderr) || [])[1] || null;

/** Break, then fix with an extra harmless edit, then break the same way again. */
function redGreenRed(p) {
  p.run();
  breakLogout(p.repo);
  p.run();
  fixLogout(p.repo);
  p.repo.write('src/notes.md', 'notes, edited with the fix\n');
  p.run();
}

test('FX1 red → green records a fix with the tests that changed; FX10 no output in it', () => {
  const p = project();
  p.run();
  p.repo.write('src/login.js', mod('login', 'function login(u) {\n  // token=sk-ant-0123456789abcdefghijklmnop\n  return { user: u + "!" };\n}'));
  p.run();
  p.repo.write('src/login.js', mod('login', 'function login(u) {\n  return { user: u };\n}'));
  p.run();
  const [f] = fixes(p.repo);
  assert.deepEqual(f.test_ids, ['node:test/app.test.js::login keeps user']);
  assert.match(f.from_state, /^st_/);
  assert.match(f.to_state, /^st_/);
  assert.deepEqual(f.files, ['src/login.js']);
  assert.equal(f.confidence, 'full diff');
  assert.equal(f.commit, null);
  const allowed = new Set(['type', 'id', 'ts', 'key', 'fingerprint', 'family', 'test_ids', 'from_state', 'to_state', 'from_run', 'to_run', 'hunks', 'files', 'stats', 'commit', 'confidence', 'first_fail_line', 'crc']);
  for (const k of Object.keys(records(p.repo.dir).find((r) => r.type === 'fix'))) assert.ok(allowed.has(k), `unexpected field ${k}`);
  assert.ok(!f.first_fail_line || f.first_fail_line.length <= 200);
});

test('FX2 an exact match on a recurrence; FX6 the confidence label; FX9 text only, nothing applied', () => {
  const p = project();
  redGreenRed(p);
  breakLogout(p.repo, 'again');
  const before = p.repo.read('src/session.js');
  const r = p.run();
  const h = hintOf(r);
  assert.match(h, /^seen before · fixed on \d{1,2} \w{3} in 2 files \(src\/notes\.md, src\/session\.js\) · kerb show fix:\w{6} \(full diff\)$/);
  assert.equal(p.repo.read('src/session.js'), before, 'the hint applies nothing');
  const id = /fix:(\w+)/.exec(h)[1];
  const show = p.repo.kerb(['show', `fix:${id}`]).stdout;
  assert.match(show, /tests {5}node:test\/app\.test\.js::logout clears session/);
  assert.match(show, /s\.user = null/);
});

test('FX3 a family-only match says it is not the same error; FX4 at most one hint', () => {
  const p = project();
  redGreenRed(p);
  // A different test failing the same way: same family, different fingerprint.
  p.repo.write('src/login.js', mod('login', 'function login(u) {\n  return { user: null };\n}'));
  const r = p.run();
  assert.match(hintOf(r), /^similar failure fixed before · kerb show fix:\w{6} \(not the same error\)$/);
  assert.equal((r.stderr.match(/kerb: hint/g) || []).length, 1);
});

test('FX5 minimisation reduces the hunks and re-verifies; FX6 the label becomes minimal', () => {
  const p = project({ cause: 'on' });
  redGreenRed(p);
  assert.equal(fixes(p.repo)[0].confidence, 'full diff');
  p.repo.kerb(['worker', '--once']);
  const [f] = fixes(p.repo);
  assert.equal(f.confidence, 'minimal');
  assert.deepEqual(f.hunks.map((h) => h.location), ['src/session.js:2']);
  assert.equal(f.hunk_count, 2);
  breakLogout(p.repo, 'third');
  assert.match(hintOf(p.run()), /in 1 hunk \(src\/session\.js\) · kerb show fix:\w{6} \(minimal\)$/);
});

test('FX7 the commit is attached once committed', () => {
  const p = project();
  redGreenRed(p);
  p.repo.kerb(['run', '--', 'git commit -qam "fix logout"'], { env: GIT_ENV });
  const [f] = fixes(p.repo);
  assert.equal(f.commit, p.repo.git('rev-parse', 'HEAD').trim());
});

test('FX8 no hint when the fix\'s tests no longer exist', () => {
  const p = project();
  redGreenRed(p);
  p.repo.write('test/app.test.js', `${testFile(['b'])}\n`); // the fixed test is gone
  p.repo.write('src/login.js', mod('login', 'function login(u) {\n  return { user: null };\n}'));
  assert.equal(hintOf(p.run()), null);
});

// ---- Notes sharing ----

function committedFix(config = {}) {
  const p = project(config);
  redGreenRed(p);
  p.repo.kerb(['run', '--', 'git commit -qam "fix logout"'], { env: GIT_ENV });
  return p;
}
const notes = (repo) => { try { return repo.git('notes', '--ref=refs/notes/kerb', 'list').trim(); } catch { return ''; } };

test('NS1 sharing is off by default: no notes are written', () => {
  const p = committedFix();
  assert.ok(fixes(p.repo)[0].commit);
  assert.equal(notes(p.repo), '');
});

test('NS2 turning sharing on is human-only; NS6 so is sync --push', async () => {
  const repo = makeRepo({ git: true });
  for (const command of ['kerb config set share_fixes true', 'kerb sync --push']) {
    const pl = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command }, tool_use_id: command };
    assert.match(JSON.parse(repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(pl) }).stdout).hookSpecificOutput.permissionDecisionReason, /human_only/, command);
  }
  const shared = makeRepo({ git: true, config: { share_fixes: true } });
  assert.equal(shared.kerb(['sync', '--push'], { input: '' }).code, 64);
});

test('NS3 only committed fixes produce notes; NS4 notes hold only fingerprint, family, test ids and version', () => {
  const p = project({ share_fixes: true });
  redGreenRed(p);
  assert.equal(notes(p.repo), '', 'not committed yet');
  p.repo.kerb(['run', '--', 'git commit -qam "fix logout"'], { env: GIT_ENV });
  const head = p.repo.git('rev-parse', 'HEAD').trim();
  const body = p.repo.git('notes', '--ref=refs/notes/kerb', 'show', head).trim();
  const entry = JSON.parse(body);
  assert.deepEqual(Object.keys(entry).sort(), ['family', 'fingerprint', 'kerb_version', 'test_ids']);
  assert.deepEqual(entry.test_ids, ['node:test/app.test.js::logout clears session']);
});

test('NS5 kerb sync merges a teammate\'s notes into the fix index; NS7 states and findings are never shared', async () => {
  const bare = tmpDir('kerb-remote-');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const a = committedFix({ share_fixes: true });
  a.repo.git('remote', 'add', 'origin', bare);
  a.repo.git('push', '-q', 'origin', 'main');
  setHumanOverrideForTests(() => true);
  try { assert.equal((await inproc(a.repo, ['sync', '--push'])).code, 0); } finally { setHumanOverrideForTests(null); }
  const refs = execFileSync('git', ['-C', bare, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.match(refs, /refs\/notes\/kerb/);
  assert.doesNotMatch(refs, /refs\/kerb\//, 'no states');
  const noteText = execFileSync('git', ['-C', bare, 'log', '-p', 'refs/notes/kerb'], { encoding: 'utf8' });
  assert.doesNotMatch(noteText, /st_[0-9a-f]{16}|"finding"|logout\(s\)/, 'only ids and fingerprints');
  // A teammate clones, syncs, and meets the same failure.
  const dir = tmpDir('kerb-clone-');
  execFileSync('git', ['clone', '-q', bare, dir], { env: baseEnv() });
  const b = makeRepo({ git: false });
  const home = b.home;
  const env = { ...baseEnv(), HOME: home, ...GIT_ENV };
  fs.mkdirSync(path.join(home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kerb', 'config.json'), JSON.stringify({ worker: 'manual' }));
  const kerb = (args) => execFileSync(process.execPath, [path.join(process.cwd(), 'bin/kerb.js'), ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(kerb(['sync']), /merged 1 shared fix from origin/);
  try { kerb(['run', '--', CMD]); } catch { /* green first */ }
  fs.writeFileSync(path.join(dir, 'src/session.js'), mod('logout', 'function logout(s) {\n  s.user = s.user; // teammate\n  return s;\n}'));
  let stderr = '';
  try { kerb(['run', '--', CMD]); } catch (e) { stderr = String(e.stderr); }
  assert.match(stderr, /kerb: hint · seen before · fixed in commit [0-9a-f]{7} \(shared\) · kerb show fix:\w{6} \(shared\)/);
});
