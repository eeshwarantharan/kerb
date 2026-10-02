// MC · The MCP server (KERB-V2 11.2, tests MC1–MC8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeRepo, recordsFixture, kerbArgv, ROOT } from './helpers.js';
import { createServer, TOOLS, MAX_TEXT, MODERN_VERSIONS } from '../src/platform/mcp.js';
import { Store } from '../src/store/jsonl.js';

const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
let n = 0;
const req = (method, params) => ({ jsonrpc: '2.0', id: ++n, method, ...(params ? { params } : {}) });
const serverFor = (repo) => createServer({ cwd: repo.dir, env: repo.env });
const callTool = (s, name, args = {}, modern = false) => s.handle(req('tools/call', { name, arguments: args, ...(modern ? { _meta: MODERN } : {}) }));

/** Every tool with arguments that find something in the fixture log. */
const CALLS = [
  ['verification_status', {}], ['progress', {}], ['attempts', {}], ['test_history', { test_id: 'logout clears session' }],
  ['known_fixes', { test_id: 'logout clears session' }], ['last_green', {}], ['cause', { test_id: 'logout clears session' }], ['boundaries', {}], ['explain', { run_id: 'rf1' }],
];

test('MC1 handshake: legacy initialize negotiates; the 2026-07-28 revision is stateless with server/discover', () => {
  const repo = makeRepo({ git: true });
  const s = serverFor(repo);
  const init = s.handle(req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'kerb');
  assert.match(init.result.instructions, /read/);
  assert.equal(s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no answer');
  assert.equal(serverFor(repo).handle(req('initialize', { protocolVersion: '2099-01-01', capabilities: {} })).result.protocolVersion, '2025-11-25', 'an unknown version: our latest legacy one');
  assert.deepEqual(s.handle(req('ping')).result, {});
  // Modern: no initialize, _meta on every request.
  const fresh = serverFor(repo);
  const d = fresh.handle(req('server/discover', { _meta: MODERN })).result;
  assert.equal(d.resultType, 'complete');
  assert.deepEqual(d.supportedVersions, MODERN_VERSIONS);
  assert.deepEqual(d.capabilities, { tools: {} });
  assert.equal(d._meta['io.modelcontextprotocol/serverInfo'].name, 'kerb');
  const list = fresh.handle(req('tools/list', { _meta: MODERN })).result;
  assert.equal(list.resultType, 'complete');
  assert.equal(list._meta['io.modelcontextprotocol/serverInfo'].name, 'kerb');
  const bad = fresh.handle(req('tools/list', { _meta: { ...MODERN, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } }));
  assert.deepEqual(bad.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: MODERN_VERSIONS, requested: '2030-01-01' } });
  const noCaps = fresh.handle(req('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }));
  assert.equal(noCaps.error.code, -32602);
});

test('MC2 tools/list lists exactly the read-only tools', () => {
  const s = serverFor(makeRepo({ git: true }));
  const { tools } = s.handle(req('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), ['verification_status', 'progress', 'attempts', 'test_history', 'known_fixes', 'last_green', 'cause', 'boundaries', 'explain']);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true);
    assert.equal(t.annotations.destructiveHint, false);
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.ok(t.description && t.title);
  }
});

test('MC3 each tool returns at most 2 KB, with a pointer when it cut', () => {
  const { repo } = recordsFixture();
  const s = serverFor(repo);
  for (const [name, args] of CALLS) {
    const r = callTool(s, name, args).result;
    assert.equal(r.isError, false, `${name}: ${r.content[0].text}`);
    assert.ok(Buffer.byteLength(r.content[0].text) <= MAX_TEXT, name);
    assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) <= MAX_TEXT, name);
  }
  // A test with many long results.
  const big = makeRepo({ git: true });
  new Store(big.dir).append(Array.from({ length: 300 }, (_, i) => ({ type: 'test_result', run: `r${i}`, ts: Date.now() + i, key: '.::pytest', test_id: 'pytest:t.py::test_x', status: 'fail', message: `assert ${'x'.repeat(150)} ${i}`, state: null })));
  const r = callTool(serverFor(big), 'test_history', { test_id: 'test_x' }).result;
  assert.ok(Buffer.byteLength(r.content[0].text) <= MAX_TEXT);
  assert.match(r.content[0].text, /… \d+ more: kerb query tests --test 'test_x'$/);
  assert.ok(Buffer.byteLength(JSON.stringify(r.structuredContent)) <= MAX_TEXT);
  assert.equal(r.structuredContent.truncated, true);
});

test('MC4 tools match the CLI', () => {
  const { repo } = recordsFixture();
  const s = serverFor(repo);
  const cli = (...a) => JSON.parse(repo.kerb(['query', ...a]).stdout);
  assert.deepEqual(callTool(s, 'verification_status').result.structuredContent, cli('verification'));
  assert.deepEqual(callTool(s, 'progress').result.structuredContent, cli('progress'));
  assert.deepEqual(callTool(s, 'known_fixes', { test_id: 'logout clears session' }).result.structuredContent, cli('fixes', '--test', 'logout clears session'));
  assert.deepEqual(callTool(s, 'cause', { test_id: 'logout clears session' }).result.structuredContent.findings[0], cli('findings').findings[0]);
  assert.equal(callTool(s, 'last_green').result.structuredContent.green.state, repo.kerb(['green', '--json']).json.green.state);
  assert.equal(callTool(s, 'attempts').result.structuredContent.keys[0].attempts, cli('progress').keys[0].runs.length);
  const fix = cli('fixes').fixes[0];
  assert.match(callTool(s, 'known_fixes', { fingerprint: fix.fingerprint }).result.content[0].text, new RegExp(`^fix:${fix.id.slice(0, 6)} .* kerb show fix:${fix.id.slice(0, 6)}$`));
  assert.match(callTool(s, 'explain', { run_id: 'rf1' }).result.content[0].text, /^refused identical_retry/);
  assert.match(callTool(s, 'cause', { test_id: 'logout clears session' }).result.content[0].text, /^kerb: cause · "logout clears session" broke/);
});

test('MC5 no write capability exists: no tool changes the records', () => {
  const { repo } = recordsFixture();
  const log = path.join(repo.dir, '.kerb/runs.jsonl');
  const before = fs.readFileSync(log);
  const s = serverFor(repo);
  for (const [name, args] of CALLS) callTool(s, name, args);
  assert.ok(fs.readFileSync(log).equals(before), 'the event log is unchanged');
  for (const f of ['src/platform/mcp.js', 'src/platform/query.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\.append\(|updateSummary|writeFileSync|appendFileSync|unlinkSync|spawn\(|exec\(/, f);
  }
  assert.ok(TOOLS.every((t) => t.annotations.readOnlyHint === true));
});

test('MC6 errors are structured MCP errors', () => {
  const s = serverFor(makeRepo({ git: true }));
  assert.equal(s.handle(req('resources/list')).error.code, -32601);
  assert.equal(s.handle(req('tools/call', { name: 'delete_everything', arguments: {} })).error.code, -32602);
  const missing = callTool(s, 'test_history', {}).result;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /test_id is required/);
  assert.equal(callTool(s, 'boundaries', { extra: 'x' }).result.isError, true);
  assert.equal(callTool(s, 'known_fixes', {}).result.isError, true);
  assert.deepEqual(s.line('{not json'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.equal(s.line('{"id":1,"method":"ping"}').error.code, -32600);
  const modernErr = callTool(s, 'nope', {}, true);
  assert.equal(modernErr.error.code, -32602);
});

/** A running `kerb mcp` and a request function that times each answer. */
function spawnServer(repo, argv = null) {
  const [cmd, args] = argv || kerbArgv(['mcp']);
  const child = spawn(cmd, args, { cwd: repo.dir, env: repo.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); w(msg); }
    }
  });
  return {
    child,
    send(method, params) {
      const m = req(method, params);
      const t0 = process.hrtime.bigint();
      return new Promise((resolve) => { waiting.set(m.id, (msg) => resolve({ msg, ms: Number(process.hrtime.bigint() - t0) / 1e6 })); child.stdin.write(`${JSON.stringify(m)}\n`); });
    },
    close() { child.stdin.end(); return new Promise((r) => child.on('close', r)); },
  };
}

test('MC7 each tool answers within 200 ms on fixtures', async () => {
  const { repo } = recordsFixture();
  const srv = spawnServer(repo);
  await srv.send('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  await srv.send('tools/call', { name: 'boundaries', arguments: {} }); // warm up
  const times = {};
  for (let round = 0; round < 3; round++) {
    for (const [name, args] of CALLS) {
      const { msg, ms } = await srv.send('tools/call', { name, arguments: args });
      assert.equal(msg.result.isError, false, name);
      (times[name] ||= []).push(ms);
    }
  }
  await srv.close();
  for (const [name, t] of Object.entries(times)) {
    const median = t.sort((a, b) => a - b)[1];
    assert.ok(median < 200, `${name}: median ${median.toFixed(1)} ms (${t.map((x) => x.toFixed(0)).join(', ')})`);
  }
});

test('MC8 init registers the server where supported', async () => {
  const repo = makeRepo({ git: true });
  const r = repo.kerb(['init', '--agent', 'claude,cursor,copilot,gemini,codex,opencode', '--json']).json;
  const claude = JSON.parse(repo.read('.mcp.json')).mcpServers.kerb;
  assert.equal(claude.type, 'stdio');
  assert.ok(path.isAbsolute(claude.command));
  assert.deepEqual(claude.args.slice(-3), ['--cwd', repo.dir, 'mcp']);
  assert.deepEqual(JSON.parse(repo.read('.cursor/mcp.json')).mcpServers.kerb, claude);
  assert.deepEqual(JSON.parse(repo.read('.vscode/mcp.json')).servers.kerb, claude);
  const { type, ...plain } = claude;
  void type;
  assert.deepEqual(JSON.parse(repo.read('.gemini/settings.json')).mcpServers.kerb, plain);
  assert.ok(r.notes.some((x) => /codex mcp add kerb -- .* mcp$/.test(x)));
  assert.ok(r.notes.some((x) => /opencode\.json/.test(x)));
  assert.match(repo.read('.gitignore'), /^\.mcp\.json$/m);
  // The registered command starts a working server.
  const srv = spawnServer(repo, [claude.command, claude.args]);
  const { msg } = await srv.send('tools/list', { _meta: MODERN });
  assert.equal(msg.result.tools.length, TOOLS.length);
  await srv.close();
  // A committed .mcp.json is left alone, with a note.
  const shared = makeRepo({ git: true, files: { '.mcp.json': '{"mcpServers":{"team":{"command":"x"}}}\n' } }); // committed by makeRepo
  const s = shared.kerb(['init', '--agent', 'claude', '--json']).json;
  assert.equal(shared.read('.mcp.json'), '{"mcpServers":{"team":{"command":"x"}}}\n');
  assert.ok(s.notes.some((x) => /\.mcp\.json is committed.*claude mcp add --scope local kerb -- /.test(x)));
});

test('MC8 uninstall removes the server entries, keeping the user\'s', async () => {
  const { setHumanOverrideForTests } = await import('../src/bound/human.js');
  const { inproc } = await import('./helpers.js');
  const repo = makeRepo({ git: true, files: { '.cursor/mcp.json': '{"mcpServers":{"mine":{"command":"x"}}}\n' } });
  repo.kerb(['init', '--agent', 'claude,cursor']);
  const cur = JSON.parse(repo.read('.cursor/mcp.json'));
  cur.mcpServers.later = { command: 'y' }; // edited after init
  repo.write('.cursor/mcp.json', `${JSON.stringify(cur, null, 2)}\n`);
  setHumanOverrideForTests(() => true);
  try { assert.equal((await inproc(repo, ['uninstall'])).code, 0); } finally { setHumanOverrideForTests(null); }
  assert.equal(repo.exists('.mcp.json'), false, 'created by init: removed');
  assert.deepEqual(JSON.parse(repo.read('.cursor/mcp.json')).mcpServers, { mine: { command: 'x' }, later: { command: 'y' } });
  assert.equal(spawnSync('git', ['-C', repo.dir, 'status', '--porcelain', '.mcp.json'], { encoding: 'utf8' }).stdout, '');
});
