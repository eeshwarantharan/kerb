// PL · Plugins with hash approval (KERB-V2 11.3, tests PL1–PL8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc, records } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { sha256 } from '../src/util/core.js';
import { runEvent, readOnlyQuery, BUDGET_MS } from '../src/platform/plugins.js';
import { loadSummary } from '../src/store/summary.js';

const PLUGIN = `export default {
  name: 'tracker',
  events: {
    'run.end'(ctx, e) { return { note: \`run exit \${e.run.exit}, \${e.failing.length} failing\` }; },
    refusal(ctx, r) { return { note: 'saw ' + r.reason, deny: true, exit: 0 }; },
    'session.start'(ctx, s) { return { note: 'hello from ' + (s.source || 'start') }; },
  },
};
`;

/** A repo whose policy lists plugin.mjs (with the right hash unless `hash` is given). */
function project({ source = PLUGIN, hash = null, listed = true, extra = {} } = {}) {
  const policy = listed ? { plugins: [{ path: 'tools/plugin.mjs', sha256: hash || sha256(source) }], ...extra } : extra;
  return makeRepo({ git: true, files: { 'tools/plugin.mjs': source, 'kerb.policy.json': JSON.stringify(policy), 'src/a.txt': '1\n' } });
}
async function approve(repo, p = 'tools/plugin.mjs') {
  setHumanOverrideForTests(() => true);
  try { return await inproc(repo, ['plugins', 'approve', p]); } finally { setHumanOverrideForTests(null); }
}
const failing = (repo) => repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
const notesOf = (r) => r.stderr.split('\n').filter((l) => l.startsWith('kerb: note · ['));
const start = (repo) => {
  const out = repo.kerb(['hook', 'claude', 'start'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t', cwd: repo.dir, hook_event_name: 'SessionStart', source: 'startup' }) }).stdout;
  return out.trim() ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
};

test('PL1 unlisted plugins never load', () => {
  const repo = project({ listed: false });
  assert.deepEqual(notesOf(failing(repo)), []);
  assert.doesNotMatch(start(repo), /tracker|hello/);
  assert.deepEqual(repo.kerb(['plugins', '--json']).json.plugins, []);
});

test('PL2 a hash mismatch is not loaded, with a warning', async () => {
  const repo = project({ hash: 'a'.repeat(64) });
  await approve(repo).catch(() => {});
  const st = repo.kerb(['plugins', '--json']).json.plugins[0];
  assert.equal(st.status, 'hash_mismatch');
  assert.deepEqual(notesOf(failing(repo)), []);
  assert.match(start(repo), /kerb: note · plugin tools\/plugin\.mjs not loaded: the file changed since it was listed/);
  // Approved, then edited: the edit is not loaded.
  const ok = project();
  await approve(ok);
  ok.write('tools/plugin.mjs', PLUGIN.replace('hello', 'pwned'));
  assert.equal(ok.kerb(['plugins', '--json']).json.plugins[0].status, 'hash_mismatch');
  assert.deepEqual(notesOf(failing(ok)), []);
});

test('PL3 repo plugins need a person\'s approval', async () => {
  const repo = project();
  assert.equal(repo.kerb(['plugins', '--json']).json.plugins[0].status, 'needs_approval');
  assert.deepEqual(notesOf(failing(repo)), []);
  assert.match(start(repo), /a person must approve it first \(kerb plugins approve tools\/plugin\.mjs\)/);
  const pl = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'kerb plugins approve tools/plugin.mjs' }, tool_use_id: 'a1' };
  assert.match(JSON.parse(repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(pl) }).stdout).hookSpecificOutput.permissionDecisionReason, /human_only · kerb plugins approve is for the user/);
  assert.equal(repo.kerb(['plugins', 'approve', 'tools/plugin.mjs'], { input: '' }).code, 64, 'no terminal: refused');
  assert.equal((await approve(repo)).code, 0);
  assert.equal(repo.kerb(['plugins', '--json']).json.plugins[0].status, 'ok');
  const approvals = JSON.parse(fs.readFileSync(path.join(repo.home, '.kerb/plugins-approved.json'), 'utf8')).approved;
  assert.equal(Object.values(approvals)[0], sha256(PLUGIN));
  assert.equal(repo.kerb(['plugins', 'revoke', 'tools/plugin.mjs']).code, 0);
  assert.equal(repo.kerb(['plugins', '--json']).json.plugins[0].status, 'needs_approval');
});

test('PL3 managed-config plugins need no approval', async () => {
  const repo = project({ listed: false });
  const { setManagedConfigPathForTests } = await import('../src/config.js');
  const managed = path.join(repo.home, 'managed.json');
  fs.writeFileSync(managed, JSON.stringify({ plugins: [{ path: path.join(repo.dir, 'tools/plugin.mjs'), sha256: sha256(PLUGIN) }] }));
  setManagedConfigPathForTests(managed);
  try {
    const r = await inproc(repo, ['plugins', '--json']);
    assert.equal(r.json.plugins[0].status, 'ok');
    assert.equal(r.json.plugins[0].layer, 'managed');
  } finally { setManagedConfigPathForTests(null); }
});

test('PL4 notes appear with the plugin name, after runs, refusals and at session start', async () => {
  const repo = project();
  await approve(repo);
  const r = failing(repo);
  assert.deepEqual(notesOf(r), ['kerb: note · [tracker] run exit 1, 0 failing']);
  // The same failing run again: an identical retry refusal (enforce mode), with the plugin's note.
  await setMode(repo);
  const again = failing(repo);
  assert.equal(again.code, 75);
  assert.match(again.stderr, /^kerb: identical_retry[\s\S]*\nkerb: note · \[tracker\] saw identical_retry$/m);
  assert.match(start(repo), /kerb: note · \[tracker\] hello from startup/);
  // Through the hooks too.
  const base = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'h1' };
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(base) });
  const post = JSON.parse(repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...base, tool_response: { stdout: 'hi', stderr: '', interrupted: false } }) }).stdout || '{}');
  assert.match(JSON.stringify(post), /kerb: note · \[tracker\] run exit 0, 0 failing/);
});

async function setMode(repo) {
  setHumanOverrideForTests(() => true);
  try { await inproc(repo, ['enforce']); } finally { setHumanOverrideForTests(null); }
}

test('PL5 handlers can\'t deny: anything but a note is ignored', async () => {
  const repo = project();
  await approve(repo);
  await setMode(repo);
  failing(repo);
  const again = failing(repo);
  assert.equal(again.code, 75, 'the refusal stands; the plugin\'s deny/exit fields change nothing');
  const ok = repo.kerb(['run', '--', 'echo fine']);
  assert.equal(ok.code, 0, 'a plugin can\'t refuse a command either');
  const recs = records(repo.dir);
  assert.ok(!recs.some((x) => x.type === 'refusal' && /tracker/.test(JSON.stringify(x))), 'no refusal comes from a plugin');
});

test('PL6 the 50 ms budget skips slow handlers; PL7 errors are counted, not raised', async () => {
  const ctx = Object.freeze({});
  const plugins = [
    { name: 'slow-async', events: { 'run.end': () => new Promise((r) => setTimeout(() => r({ note: 'late' }), BUDGET_MS * 3)) } },
    { name: 'slow-sync', events: { 'run.end': () => { const t = Date.now(); while (Date.now() - t < BUDGET_MS + 20) { /* spin */ } return { note: 'late too' }; } } },
    { name: 'thrower', events: { 'run.end': () => { throw new Error('boom'); } } },
    { name: 'rejecter', events: { 'run.end': async () => { throw new Error('boom'); } } },
    { name: 'fine', events: { 'run.end': () => ({ note: 'on time' }) } },
  ];
  const r = await runEvent(plugins, 'run.end', { run: {} }, ctx);
  assert.deepEqual(r.notes, [{ plugin: 'fine', text: 'on time' }]);
  assert.deepEqual(r.counts['slow-async'], { calls: 1, timeouts: 1, errors: 0 });
  assert.deepEqual(r.counts['slow-sync'], { calls: 1, timeouts: 1, errors: 0 });
  assert.deepEqual(r.counts.thrower, { calls: 1, timeouts: 0, errors: 1 });
  assert.deepEqual(r.counts.rejecter, { calls: 1, timeouts: 0, errors: 1 });
  // End to end: a throwing plugin never breaks a run, and its errors are counted in the summary.
  const src = "export default { name: 'broken', events: { 'run.end'() { throw new Error('boom'); } } };\n";
  const repo = project({ source: src });
  await approve(repo);
  const run = failing(repo);
  assert.equal(run.code, 1);
  assert.doesNotMatch(run.stderr, /boom/);
  assert.deepEqual(loadSummary(path.join(repo.dir, '.kerb')).plugins.broken, { calls: 1, timeouts: 0, errors: 1 });
  assert.match(repo.kerb(['plugins']).stdout, /broken: 1 calls, 0 over the 50 ms budget, 1 errors \(skipped\)/);
});

test('PL8 ctx.query is read-only', async () => {
  const repo = project();
  await approve(repo);
  failing(repo);
  const q = readOnlyQuery(repo.dir, repo.env);
  assert.ok(Object.isFrozen(q));
  assert.throws(() => { 'use strict'; q.runs = () => ({}); }, TypeError);
  const runs = q.runs();
  assert.equal(runs.runs.length, 1);
  assert.throws(() => { runs.runs.push({}); }, TypeError, 'answers are frozen copies');
  assert.equal(q.runs().runs.length, 1);
  assert.equal(typeof q.records, 'undefined', 'no raw access to the log');
  assert.ok(!Object.keys(q).some((k) => /append|write|set|delete|update/i.test(k)));
  // A plugin that tries to write through ctx gets nothing, and the log is unchanged.
  const src = "export default { name: 'writer', events: { 'run.end'(ctx) { try { ctx.query.runs().runs.push(1); } catch { return { note: 'frozen' }; } return { note: 'mutable' }; } } };\n";
  const w = project({ source: src });
  await approve(w);
  assert.deepEqual(notesOf(failing(w)), ['kerb: note · [writer] frozen']);
});
