import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc } from './helpers.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';

const SETTINGS = '.claude/settings.local.json';

function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.kerb') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const initClaude = (repo, extra = []) => repo.kerb(['init', '--agent', 'claude', ...extra]);

test('I1 init merges into existing agent settings without losing keys', () => {
  const existing = {
    permissions: { allow: ['Bash(npm test:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edit' }] }] },
    env: { FOO: '1' },
  };
  const repo = makeRepo({ git: true, files: { [SETTINGS]: JSON.stringify(existing, null, 2) } });
  assert.equal(initClaude(repo).code, 0);
  const s = JSON.parse(repo.read(SETTINGS));
  assert.deepEqual(s.permissions, existing.permissions);
  assert.deepEqual(s.env, existing.env);
  assert.equal(s.hooks.PreToolUse[0].matcher, 'Edit');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo edit');
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Bash' && /hook claude pre$/.test(g.hooks[0].command)));
  for (const e of ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'Stop']) assert.ok(s.hooks[e], e);
});

test('I2 running init twice changes nothing', () => {
  const repo = makeRepo({ git: true, files: { 'CLAUDE.md': '# Project\n' } });
  initClaude(repo);
  const before = snapshot(repo.dir);
  const r = initClaude(repo);
  assert.match(r.stdout, /nothing to change/);
  assert.deepEqual(snapshot(repo.dir), before);
});

test('I3 uninstall restores the original files byte for byte (outside markers)', async () => {
  const files = {
    'AGENTS.md': '# Agents\nBe nice.\n',
    'CLAUDE.md': 'no trailing newline',
    '.gitignore': 'node_modules\n',
    [SETTINGS]: '{\n  "permissions": {"allow": ["Bash(ls)"]}\n}\n',
  };
  const repo = makeRepo({ git: true, files });
  const before = snapshot(repo.dir);
  assert.equal(initClaude(repo).code, 0);
  assert.notDeepEqual(snapshot(repo.dir), before);
  assert.equal(repo.kerb(['uninstall']).code, 64, 'uninstall needs a human');
  setHumanOverrideForTests(() => true);
  try {
    const r = await inproc(repo, ['uninstall']);
    assert.equal(r.code, 0);
  } finally {
    setHumanOverrideForTests(null);
  }
  assert.deepEqual(snapshot(repo.dir), before);
  assert.equal(fs.existsSync(path.join(repo.dir, '.claude/skills')), false);
});

test('I3 uninstall after the user edited a file removes only Kerb\'s parts', async () => {
  const repo = makeRepo({ git: true });
  initClaude(repo);
  const s = JSON.parse(repo.read(SETTINGS));
  s.permissions = { allow: ['Bash(make:*)'] };
  repo.write(SETTINGS, JSON.stringify(s, null, 2));
  repo.write('AGENTS.md', `${repo.read('AGENTS.md')}\n## Mine\nkeep me\n`);
  setHumanOverrideForTests(() => true);
  try { await inproc(repo, ['uninstall']); } finally { setHumanOverrideForTests(null); }
  assert.deepEqual(JSON.parse(repo.read(SETTINGS)), { permissions: { allow: ['Bash(make:*)'] } });
  assert.equal(repo.read('AGENTS.md').includes('kerb:start'), false);
  assert.match(repo.read('AGENTS.md'), /keep me/);
});

test('I4 an existing status line is kept, and instructions are printed', () => {
  const repo = makeRepo({ git: true });
  fs.mkdirSync(path.join(repo.home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.claude/settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '~/my-status.sh' } }));
  const r = initClaude(repo);
  assert.match(r.stdout, /already has a status line.*statusline --segment/);
  assert.equal(JSON.parse(repo.read(SETTINGS)).statusLine, undefined);
  const fresh = makeRepo({ git: true });
  initClaude(fresh);
  assert.match(JSON.parse(fresh.read(SETTINGS)).statusLine.command, /statusline$/);
});

test('I5 .kerb/ is added to .gitignore once', () => {
  const repo = makeRepo({ git: true, files: { '.gitignore': 'dist' } });
  initClaude(repo);
  initClaude(repo);
  assert.equal(repo.read('.gitignore'), 'dist\n.kerb/\n');
});

test('I6 the skill is installed with frontmatter on line 1', () => {
  const repo = makeRepo({ git: true });
  initClaude(repo);
  const skill = repo.read('.claude/skills/kerb/SKILL.md');
  assert.equal(skill.split('\n')[0], '---');
  assert.match(skill, /^name: kerb$/m);
});

test('I7 --dry-run changes nothing and lists the plan', () => {
  const repo = makeRepo({ git: true });
  const before = snapshot(repo.dir);
  const r = initClaude(repo, ['--dry-run']);
  assert.match(r.stdout, /would create \.claude\/settings\.local\.json/);
  assert.match(r.stdout, /would create AGENTS\.md/);
  assert.deepEqual(snapshot(repo.dir), before);
  assert.equal(fs.existsSync(path.join(repo.dir, '.kerb/install.json')), false);
});

test('I8 doctor reports a missing hook with the exact fix', () => {
  const repo = makeRepo({ git: true });
  initClaude(repo);
  const s = JSON.parse(repo.read(SETTINGS));
  delete s.hooks.Stop;
  repo.write(SETTINGS, JSON.stringify(s, null, 2));
  const d = repo.kerb(['doctor']);
  assert.equal(d.code, 1);
  assert.match(d.stdout, /fail · Claude Code: missing Stop hook in \.claude\/settings\.local\.json\n\s+fix: kerb init --agent claude/);
});

test('I9 hook commands use absolute paths (Node plus the script, or the binary)', () => {
  const repo = makeRepo({ git: true });
  initClaude(repo);
  const s = JSON.parse(repo.read(SETTINGS));
  const cmd = s.hooks.PreToolUse.find((g) => g.matcher === 'Bash').hooks[0].command;
  const words = cmd.split(' hook ')[0].split(' ').map((w) => w.replace(/"/g, ''));
  for (const w of words) {
    assert.ok(path.isAbsolute(w), w);
    assert.ok(fs.existsSync(w), w);
  }
  if (words.length === 2) assert.match(words[1], /(bin\/kerb\.js|kerb\.cjs)$/, 'Node plus the entry script');
  else assert.equal(words.length, 1, 'or the standalone binary');
});

test('I10 a moved Node path: doctor reports it stale and init --refresh fixes it', () => {
  const repo = makeRepo({ git: true });
  initClaude(repo);
  const text = repo.read(SETTINGS);
  const node = JSON.parse(text).hooks.PreToolUse[0].hooks[0].command.split(' ')[0];
  repo.write(SETTINGS, text.split(node).join('/opt/old-node/v18.0.0/bin/node'));
  const d = repo.kerb(['doctor']);
  assert.equal(d.code, 1);
  assert.match(d.stdout, /no longer exists[\s\S]*fix: kerb init --refresh/);
  assert.equal(repo.kerb(['init', '--refresh']).code, 0);
  const again = repo.kerb(['doctor']);
  assert.equal(again.code, 0, again.stdout);
  assert.match(again.stdout, /ok\s+· Claude Code: enforced/);
});

test('I11 init output states each agent\'s tier', () => {
  const repo = makeRepo({ git: true });
  const r = initClaude(repo);
  assert.match(r.stdout, /Claude Code\s+enforced \(native hooks\)/);
  assert.match(r.stdout, /any other agent\s+best effort/);
  const j = repo.kerb(['init', '--json', '--agent', 'claude']);
  assert.equal(j.json.agents.claude.tier, 'enforced');
});
