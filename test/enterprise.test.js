import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc, tmpDir } from './helpers.js';
import { managedConfigPath, setManagedConfigPathForTests, loadConfig, setUserConfig } from '../src/config.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { orgLayer } from '../src/bound/org.js';

function withManaged(obj, home, fn) {
  const file = path.join(tmpDir(), 'managed.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  setManagedConfigPathForTests(file);
  return Promise.resolve().then(fn).finally(() => {
    setManagedConfigPathForTests(null);
    process.env.HOME = oldHome;
  });
}

test('E1 the managed config is found at each OS path', () => {
  assert.equal(managedConfigPath('linux'), '/etc/kerb/managed.json');
  assert.equal(managedConfigPath('darwin'), '/Library/Application Support/Kerb/managed.json');
  assert.equal(managedConfigPath('win32', { ProgramData: 'C:\\ProgramData' }), path.join('C:\\ProgramData', 'Kerb', 'managed.json'));
});

test('E2 managed defaults override user config', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.kerb'));
  fs.writeFileSync(path.join(home, '.kerb/config.json'), JSON.stringify({ recap: 'on', budget: 5000 }));
  await withManaged({ defaults: { recap: 'off' } }, home, () => {
    const c = loadConfig();
    assert.equal(c.values.recap, 'off');
    assert.equal(c.values.budget, 5000, 'other user values stay');
  });
});

test('E3 locked keys cannot be changed', async () => {
  const repo = makeRepo();
  await withManaged({ defaults: { telemetry: 'on' }, locked: ['telemetry'] }, repo.home, async () => {
    assert.throws(() => setUserConfig('telemetry', 'off'), /locked by your organisation/);
    setHumanOverrideForTests(() => true);
    try {
      const r = await inproc(repo, ['config', 'set', 'telemetry', 'off']);
      assert.equal(r.code, 64);
      assert.match(r.stderr, /locked/);
      assert.match((await inproc(repo, ['config', 'get', 'telemetry'])).stdout, /telemetry = on {2}\(locked by your organisation\)/);
      assert.equal((await inproc(repo, ['config', 'set', 'recap', 'off'])).code, 0, 'unlocked keys still work');
    } finally {
      setHumanOverrideForTests(null);
    }
  });
});

test('E4 lock_repo_alternatives drops repo alternatives', async () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://evil.example' }] }) } });
  await withManaged({ lock_repo_alternatives: true }, repo.home, async () => {
    const r = await inproc(repo, ['check', '--', 'npm i x']);
    assert.equal(r.code, 77);
    assert.ok(!r.stderr.includes('evil.example'));
  });
});

test('E5 the managed pinned key cannot be overridden by user config', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ org: { bundle_url: 'https://evil.example/b.json', public_key: 'AAAA' }, 'org.public_key': 'AAAA' }));
  await withManaged({ org: { bundle_url: 'https://policy.corp/b.json', public_key: 'Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg=' } }, repo.home, async () => {
    const c = loadConfig();
    assert.equal(c.managed.org.bundle_url, 'https://policy.corp/b.json');
    assert.equal(c.values['org.public_key'], undefined);
    const o = orgLayer(c.managed, Date.now());
    assert.equal(o.status.url, 'https://policy.corp/b.json');
    setHumanOverrideForTests(() => true);
    try {
      assert.equal((await inproc(repo, ['config', 'set', 'org.public_key', 'AAAA'])).code, 64);
    } finally {
      setHumanOverrideForTests(null);
    }
  });
});

// ---------------------------------------------------------------------------
// 6.2 export-denials and review

import { lintPolicy } from '../src/bound/policy.js';

test('E6 export-denials contains no command text or output', () => {
  const repo = makeRepo({ files: { curl: '#!/bin/sh\necho "OUTPUT-MARKER blocked by policy: a.example"\nexit 56\n' } });
  fs.chmodSync(path.join(repo.dir, 'curl'), 0o755);
  repo.kerb(['run', '--', './curl https://a.example/COMMAND-MARKER']);
  const r = repo.kerb(['export-denials', '--since', '7d']);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.equal(e.pattern, 'a.example');
  assert.equal(e.status, 'confirmed');
  assert.ok(e.machine);
  assert.ok(!r.stdout.includes('COMMAND-MARKER'));
  assert.ok(!r.stdout.includes('OUTPUT-MARKER'));
  assert.ok(!('keys' in e) && !('evidence_run' in e));
  assert.equal(repo.kerb(['export-denials', '--json']).json.entries.length, 1);
});

function exports(dir) {
  const mk = (machine, patterns) => {
    const f = path.join(dir, `${machine}.jsonl`);
    fs.writeFileSync(f, patterns.map((p) => JSON.stringify({ kind: 'host', pattern: p, status: 'confirmed', hits: 2, machine, first_seen: 1, last_seen: Date.now() })).join('\n'));
    return f;
  };
  return [
    mk('m1', ['a.example', 'b.example', 'registry.npmjs.org']),
    mk('m2', ['a.example', 'b.example', 'registry.npmjs.org']),
    mk('m3', ['a.example', 'registry.npmjs.org']),
  ];
}

test('E7 review keeps only entries seen from 3 or more machines', () => {
  const repo = makeRepo();
  const files = exports(tmpDir());
  const r = repo.kerb(['review', '--json', '--denials', ...files, '--out', repo.home]);
  assert.deepEqual(r.json.candidates.map((c) => c.pattern).sort(), ['a.example', 'registry.npmjs.org']);
  assert.deepEqual(r.json.below_threshold.map((c) => c.pattern), ['b.example']);
});

test('E8 review writes a valid policy patch and a Markdown summary', () => {
  const repo = makeRepo();
  const out = tmpDir();
  repo.kerb(['review', '--denials', ...exports(tmpDir()), '--out', out]);
  const patch = JSON.parse(fs.readFileSync(path.join(out, 'policy.patch.json'), 'utf8'));
  assert.deepEqual(lintPolicy(patch).filter((p) => p.level === 'error'), []);
  assert.equal(patch.boundaries.length, 2);
  const md = fs.readFileSync(path.join(out, 'review.md'), 'utf8');
  assert.match(md, /^# Kerb denial review/);
  assert.match(md, /## a\.example\n\nSeen on 3 machines/);
  assert.match(md, /Open it in the firewall[\s\S]*Add an alternative[\s\S]*Confirm the block/);
});

test('E9 review never proposes loosening a higher-layer block', () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp', why: 'mirror' }] }) } });
  const out = tmpDir();
  const r = repo.kerb(['review', '--json', '--denials', ...exports(tmpDir()), '--out', out]);
  assert.ok(!r.json.candidates.some((c) => c.pattern === 'registry.npmjs.org'));
  assert.equal(r.json.already_blocked[0].pattern, 'registry.npmjs.org');
  const patch = JSON.parse(fs.readFileSync(path.join(out, 'policy.patch.json'), 'utf8'));
  assert.ok(!patch.boundaries.some((b) => b.pattern === 'registry.npmjs.org'));
  assert.match(fs.readFileSync(path.join(out, 'review.md'), 'utf8'), /## Already blocked by policy[\s\S]*registry\.npmjs\.org: covered by `registry\.npmjs\.org` \(repo policy/);
});

// ---------------------------------------------------------------------------
// 6.3 OTLP telemetry

import http from 'node:http';

async function collector(status = 200) {
  const got = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { got.push({ url: req.url, body }); res.statusCode = status; res.end('{}'); });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, got, close: () => s.close() };
}

async function endHook(repo, sessionId) {
  const { main } = await import('../src/cli/main.js');
  return main(['hook', 'claude', 'end'], { stdin: JSON.stringify({ session_id: sessionId, cwd: repo.dir, hook_event_name: 'SessionEnd', reason: 'other' }), stdout: { write() {} }, stderr: { write() {} }, cwd: repo.dir });
}

function sessionActivity(repo) {
  const p = (cmd, id) => ({ session_id: 'sess-t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: id });
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('docker ps --secret-arg', 'x1')) });
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p('ls', 'x2')) });
  repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...p('ls', 'x2'), tool_response: { stdout: 'a', stderr: '', interrupted: false } }) });
}

test('E10 telemetry is off by default: no request', async () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  sessionActivity(repo);
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls++; return orig(...a); };
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  try { await endHook(repo, 'sess-t'); } finally { globalThis.fetch = orig; process.env.HOME = oldHome; }
  assert.equal(calls, 0);
});

test('E11 when on: one batch at session end, valid OTLP JSON; E12 no commands or paths', async () => {
  const c = await collector();
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  sessionActivity(repo);
  try {
    await withManaged({ telemetry: { otlp_endpoint: c.url }, defaults: { telemetry: 'on' } }, repo.home, async () => {
      await endHook(repo, 'sess-t');
      await endHook(repo, 'sess-t');
    });
  } finally { c.close(); }
  assert.equal(c.got.length, 1, 'one batch per session');
  assert.equal(c.got[0].url, '/v1/metrics');
  const body = JSON.parse(c.got[0].body);
  const rm = body.resourceMetrics[0];
  assert.ok(rm.resource.attributes.some((a) => a.key === 'service.name' && a.value.stringValue === 'kerb'));
  const metrics = rm.scopeMetrics[0].metrics;
  const byName = Object.fromEntries(metrics.map((m) => [m.name, m]));
  for (const n of ['kerb.runs', 'kerb.refusals', 'kerb.bytes_trimmed', 'kerb.polls_folded', 'kerb.walls_learned', 'kerb.hash_budget_skips']) assert.ok(byName[n], n);
  for (const m of metrics) {
    assert.equal(m.sum.aggregationTemporality, 1);
    for (const p of m.sum.dataPoints) {
      assert.match(p.asInt, /^\d+$/);
      assert.match(p.timeUnixNano, /^\d+$/);
    }
  }
  const refused = byName['kerb.refusals'].sum.dataPoints.find((p) => p.attributes.some((a) => a.key === 'kerb.reason' && a.value.stringValue === 'policy_blocked'));
  assert.equal(refused.asInt, '1');
  assert.ok(!c.got[0].body.includes('--secret-arg'), 'E12 no commands');
  assert.ok(!c.got[0].body.includes(repo.dir), 'E12 no paths');
  assert.ok(!c.got[0].body.includes(process.env.USER || 'no-user-set'), 'E12 no usernames');
});

test('E12 include_commands adds refused commands', async () => {
  const c = await collector();
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  sessionActivity(repo);
  try {
    await withManaged({ telemetry: { otlp_endpoint: `${c.url}/v1/metrics`, include_commands: true }, defaults: { telemetry: 'on' } }, repo.home, () => endHook(repo, 'sess-t'));
  } finally { c.close(); }
  assert.match(c.got[0].body, /docker ps --secret-arg/);
});

test('E13 a telemetry failure is silent and counted', async () => {
  const c = await collector(503);
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  sessionActivity(repo);
  let code;
  try {
    await withManaged({ telemetry: { otlp_endpoint: c.url }, defaults: { telemetry: 'on' } }, repo.home, async () => { code = await endHook(repo, 'sess-t'); });
  } finally { c.close(); }
  assert.equal(code, 0);
  const summary = JSON.parse(fs.readFileSync(path.join(repo.dir, '.kerb/summary.json'), 'utf8'));
  assert.equal(summary.telemetry_failures, 1);
  const down = makeRepo();
  down.kerb(['run', '--', 'true']);
  await withManaged({ telemetry: { otlp_endpoint: 'http://127.0.0.1:9/' }, defaults: { telemetry: 'on' } }, down.home, async () => { assert.equal(await endHook(down, null), 0); });
});
