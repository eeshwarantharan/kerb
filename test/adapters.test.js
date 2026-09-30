import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeRepo, records, inproc, ROOT } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';

const FIX = (agent, name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/hooks', agent, name), 'utf8'));

/** Per-agent payload plumbing: how to set command, cwd and id, and how a deny looks. */
const AGENTS = [
  {
    name: 'copilot (CLI)', agent: 'copilot', dir: 'copilot', pre: 'pre-cli.json', post: 'post-cli.json',
    set: (p, cmd, cwd) => { p.toolArgs.command = cmd; p.cwd = cwd; return p; },
    denied: (j) => j && j.permissionDecision === 'deny' && j.hookSpecificOutput.permissionDecision === 'deny',
    reason: (j) => j.permissionDecisionReason,
  },
  {
    name: 'copilot (VS Code)', agent: 'copilot', dir: 'copilot', pre: 'pre-vscode.json', post: 'post-vscode.json',
    set: (p, cmd, cwd, id) => { p.tool_input.command = cmd; p.cwd = cwd; p.tool_use_id = id; return p; },
    denied: (j) => j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny',
    reason: (j) => j.hookSpecificOutput.permissionDecisionReason,
  },
  {
    name: 'cursor', agent: 'cursor', dir: 'cursor', pre: 'pre.json', post: 'post.json',
    set: (p, cmd, cwd, id) => { p.tool_input.command = cmd; p.tool_input.working_directory = cwd; p.cwd = cwd; p.workspace_roots = [cwd]; p.tool_use_id = id; return p; },
    denied: (j) => j && j.permission === 'deny',
    reason: (j) => j.agent_message,
  },
  {
    name: 'codex', agent: 'codex', dir: 'codex', pre: 'pre.json', post: 'post.json',
    set: (p, cmd, cwd, id) => { p.tool_input.command = cmd; p.cwd = cwd; p.tool_use_id = id; return p; },
    denied: (j) => j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'deny',
    reason: (j) => j.hookSpecificOutput.permissionDecisionReason,
  },
  {
    name: 'gemini', agent: 'gemini', dir: 'gemini', pre: 'pre.json', post: 'post.json',
    set: (p, cmd, cwd) => { p.tool_input.command = cmd; p.cwd = cwd; return p; },
    denied: (j) => j && j.decision === 'deny',
    reason: (j) => j.reason,
  },
  {
    name: 'opencode', agent: 'opencode', dir: 'opencode', pre: 'pre.json', post: 'post.json',
    set: (p, cmd, cwd, id) => { p.args.command = cmd; p.cwd = cwd; p.callID = id; return p; },
    denied: (j) => j && typeof j.deny === 'string',
    reason: (j) => j.deny,
  },
];

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker', why: 'no docker here' }] }) };
const allOutputs = [];

function hook(repo, a, event, payload) {
  const r = repo.kerb(['hook', a.agent, event], { input: JSON.stringify(payload) });
  allOutputs.push(r.stdout);
  let json = null;
  try { json = r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { /* */ }
  return { ...r, json };
}

for (const a of AGENTS) {
  const pre = (repo, cmd, id) => hook(repo, a, 'pre', a.set(FIX(a.dir, a.pre), cmd, repo.dir, id));
  const post = (repo, cmd, id) => hook(repo, a, 'post', a.set(FIX(a.dir, a.post), cmd, repo.dir, id));

  test(`G1 ${a.name}: a blocked command is denied`, () => {
    const repo = makeRepo({ files: POLICY });
    const r = pre(repo, 'docker ps', 'g1');
    assert.equal(r.code, 0);
    assert.ok(a.denied(r.json), r.stdout);
    assert.match(a.reason(r.json), /^kerb: policy_blocked · docker is blocked here/);
  });

  test(`G2 ${a.name}: an allowed command passes with no decision`, () => {
    const repo = makeRepo({ files: POLICY });
    const r = pre(repo, 'ls -la', 'g2');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });

  test(`G3 ${a.name}: results are recorded and feed Loopbreaker`, () => {
    const repo = makeRepo({ git: true, files: { 'a.js': '1\n' }, config: { hash_budget_ms: 10000 } });
    assert.equal(pre(repo, 'npm test', 'g3a').stdout, '');
    post(repo, 'npm test', 'g3a');
    const end = records(repo.dir).find((r) => r.type === 'end');
    assert.equal(end.exit, 1, 'exit code parsed from the agent payload');
    assert.equal(records(repo.dir).find((r) => r.type === 'start').agent, a.agent);
    const again = pre(repo, 'npm test', 'g3b');
    assert.ok(a.denied(again.json), again.stdout);
    assert.match(a.reason(again.json), /identical_retry/);
  });

  test(`G4 ${a.name}: fails open`, () => {
    const repo = makeRepo();
    const r = repo.kerb(['hook', a.agent, 'pre'], { input: '{"broken":' });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '');
  });
}

test('G5 the instructions-only path records the tier as best effort', () => {
  const repo = makeRepo({ git: true });
  const r = repo.kerb(['init', '--json', '--agent', 'other']);
  assert.equal(r.json.agents.other.tier, 'best effort');
  assert.deepEqual(r.json.files.map((f) => f.file).sort(), ['.gitignore', 'AGENTS.md']);
  const s = repo.kerb(['init', '--agent', 'other']);
  assert.match(s.stdout, /Any other agent\s+best effort \(instructions only/);
});

const INSTALL = {
  copilot: ['.github/hooks/kerb.json', '.github/skills/kerb/SKILL.md'],
  cursor: ['.cursor/hooks.json'],
  codex: ['.codex/hooks.json'],
  gemini: ['.gemini/settings.json'],
  opencode: ['.opencode/plugins/kerb.js'],
};

for (const [agent, files] of Object.entries(INSTALL)) {
  test(`G6 ${agent}: init and uninstall are idempotent and exact`, async () => {
    const pre = agent === 'gemini' ? { '.gemini/settings.json': '{\n  "theme": "dark"\n}\n' } : {};
    const repo = makeRepo({ git: true, files: pre });
    const before = fs.readdirSync(repo.dir).sort();
    const first = repo.kerb(['init', '--json', '--agent', agent]);
    assert.equal(first.json.agents[agent].tier, 'enforced');
    for (const f of files) assert.ok(repo.exists(f), f);
    const snap = Object.fromEntries(files.map((f) => [f, repo.read(f)]));
    const second = repo.kerb(['init', '--json', '--agent', agent]);
    assert.deepEqual(second.json.files, []);
    for (const f of files) assert.equal(repo.read(f), snap[f]);
    assert.equal(repo.kerb(['doctor', '--json']).json.ok, true);
    if (agent === 'gemini') {
      const s = JSON.parse(repo.read('.gemini/settings.json'));
      assert.equal(s.theme, 'dark');
      assert.equal(s.hooks.BeforeTool[0].matcher, 'run_shell_command');
      assert.equal(s.hooks.BeforeTool[0].hooks[0].timeout, 5000, 'Gemini timeouts are in ms');
    }
    setHumanOverrideForTests(() => true);
    try { await inproc(repo, ['uninstall']); } finally { setHumanOverrideForTests(null); }
    for (const f of files) if (!pre[f]) assert.equal(repo.exists(f), false, f);
    if (pre['.gemini/settings.json']) assert.equal(repo.read('.gemini/settings.json'), pre['.gemini/settings.json']);
    assert.deepEqual(fs.readdirSync(repo.dir).filter((n) => n !== '.kerb').sort(), before.filter((n) => n !== '.kerb'));
  });
}

test('G7 payload fixtures are in the repo for every agent', () => {
  for (const a of ['claude', 'copilot', 'cursor', 'codex', 'gemini', 'opencode']) {
    const d = path.join(ROOT, 'test/fixtures/hooks', a);
    assert.ok(fs.readdirSync(d).some((f) => f.startsWith('pre')), a);
    assert.ok(fs.readdirSync(d).some((f) => f.startsWith('post')), a);
  }
});

test('the generated OpenCode plugin denies by throwing and records results', async () => {
  const repo = makeRepo({ git: true, files: { ...POLICY, 'a.js': '1\n' } });
  repo.kerb(['init', '--agent', 'opencode']);
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  try {
    // OpenCode loads plugins with Bun, which accepts ESM in .js; Node needs .mjs.
    const copy = path.join(repo.home, 'kerb-plugin.mjs');
    fs.copyFileSync(path.join(repo.dir, '.opencode/plugins/kerb.js'), copy);
    const mod = await import(pathToFileURL(copy).href);
    const hooks = await mod.Kerb({ directory: repo.dir });
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c1' }, { args: { command: 'docker ps' } }), /kerb: policy_blocked/);
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's', callID: 'c2' }, { args: { command: 'npm test' } });
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's', callID: 'c2', args: { command: 'npm test' } }, { title: 't', output: 'FAIL\n', metadata: { exit: 1 } });
    await hooks['tool.execute.before']({ tool: 'read', sessionID: 's', callID: 'c3' }, { args: { filePath: 'x' } });
  } finally {
    process.env.HOME = oldHome;
  }
  const end = records(repo.dir).find((r) => r.type === 'end');
  assert.equal(end.exit, 1);
  assert.equal(end.class, 'check');
});

test('a Copilot CLI call seen through two hook files is recorded once', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const a = AGENTS[0];
  const p = a.set(FIX('copilot', 'pre-cli.json'), 'npm test', repo.dir);
  const viaClaude = { hook_event_name: 'PreToolUse', session_id: p.sessionId, timestamp: '2026-10-01T10:00:00Z', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'npm test' } };
  hook(repo, a, 'pre', p);
  const c = repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(viaClaude) });
  assert.equal(c.stdout, '');
  hook(repo, a, 'post', a.set(FIX('copilot', 'post-cli.json'), 'npm test', repo.dir));
  repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...viaClaude, hook_event_name: 'PostToolUse', tool_result: { result_type: 'success', text_result_for_llm: 'FAIL\n<exited with exit code 1>' } }) });
  assert.equal(records(repo.dir).filter((r) => r.type === 'end').length, 1);
});

test('adapters never emit an allow or approve decision', () => {
  for (const o of allOutputs) {
    assert.ok(!/"(permissionDecision|permission|decision)":"(allow|approve|ask)"/.test(o), o);
    assert.ok(!/updated_?[iI]nput|modifiedArgs/.test(o), o);
  }
});
