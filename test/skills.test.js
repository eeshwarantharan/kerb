// SK · Skills pack and packaging (KERB-V2 10.4, tests SK1–SK4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';
import { COMMANDS } from '../src/cli/main.js';
import { SKILL } from '../src/init/instructions.js';

const SKILLS = path.join(ROOT, 'skills');
const names = fs.readdirSync(SKILLS).filter((d) => fs.existsSync(path.join(SKILLS, d, 'SKILL.md'))).sort();
const read = (n) => fs.readFileSync(path.join(SKILLS, n, 'SKILL.md'), 'utf8');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

/** YAML frontmatter as flat key: value pairs, or null when line 1 isn't `---`. */
function frontmatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;
  return Object.fromEntries(lines.slice(1, end).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
}

test('SK1 each skill has valid frontmatter on line 1', () => {
  assert.deepEqual(names, ['kerb', 'kerb-before-done', 'kerb-diagnose']);
  for (const n of names) {
    const fm = frontmatter(read(n));
    assert.ok(fm, `${n}: frontmatter on line 1`);
    assert.equal(fm.name, n, `${n}: name matches its directory`);
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.description && fm.description.length >= 40 && fm.description.length <= 1024, `${n}: a description`);
  }
  assert.equal(read('kerb'), SKILL, 'skills/kerb is the skill kerb init installs');
});

test('SK2 every command a skill mentions exists', () => {
  for (const n of names) {
    const text = read(n);
    const mentioned = [...text.matchAll(/`kerb ([a-z][a-z-]*)/g)].map((m) => m[1]);
    assert.ok(mentioned.length, n);
    for (const c of mentioned) assert.ok(COMMANDS[c], `${n} mentions kerb ${c}, which doesn't exist`);
  }
});

test('SK3 kerb-before-done never instructs claiming success without green status', () => {
  const text = read('kerb-before-done');
  assert.match(text, /Only when every check you touched is `green` may you say the tests pass\./);
  assert.match(text, /Never say "tests pass", "all green" or "done" from an earlier run/);
  for (const line of text.split('\n')) {
    if (/tests pass|all green|\bdone\b|finished|passed/i.test(line)) assert.match(line, /green|never|before|only|don't|wasn't|not/i, `a success claim without the green condition: ${line}`);
  }
});

test('SK4 packaging validates against the VERIFY\'d formats', () => {
  const pkg = json('package.json');
  // Claude Code plugin manifest (code.claude.com/docs/en/plugins-reference).
  const plugin = json('.claude-plugin/plugin.json');
  assert.match(plugin.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.doesNotMatch(plugin.name, /^(claude|anthropic)-/);
  assert.equal(plugin.version, pkg.version);
  assert.ok(plugin.author && plugin.author.name);
  assert.doesNotThrow(() => new URL(plugin.homepage));
  assert.ok(!fs.existsSync(path.join(ROOT, '.claude-plugin/skills')), 'components live at the plugin root, not in .claude-plugin/');
  // Marketplace (code.claude.com/docs/en/plugins/marketplace-reference).
  const mkt = json('.claude-plugin/marketplace.json');
  assert.match(mkt.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  assert.ok(!mkt.name.includes('..'));
  assert.ok(!['claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official', 'anthropic-marketplace', 'anthropic-plugins', 'agent-skills', 'inline', 'builtin', 'skills-dir', 'synced', 'npm', 'github'].includes(mkt.name));
  assert.ok(mkt.owner && mkt.owner.name);
  assert.ok(mkt.description);
  assert.equal(new Set(mkt.plugins.map((p) => p.name)).size, mkt.plugins.length);
  for (const p of mkt.plugins) {
    assert.match(p.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(p.source === '.' || (p.source.startsWith('./') && !p.source.includes('..')), 'a relative source inside the marketplace');
    assert.equal(p.version, undefined, 'the version comes from plugin.json');
  }
  // MCP registry server.json (modelcontextprotocol/registry docs/reference/server-json).
  const server = json('server.json');
  assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d\d-\d\d\/server\.schema\.json$/);
  assert.match(server.name, /^io\.github\.[\w-]+\/[\w-]+$/);
  assert.equal(server.name, pkg.mcpName, 'npm ownership: package.json mcpName');
  assert.equal(server.version, pkg.version);
  assert.ok(server.description && server.description.length <= 200);
  const [npm] = server.packages;
  assert.equal(npm.registryType, 'npm');
  assert.equal(npm.identifier, pkg.name);
  assert.equal(npm.version, pkg.version);
  assert.equal(npm.transport.type, 'stdio');
  assert.deepEqual(npm.packageArguments, [{ type: 'positional', value: 'mcp' }]);
  assert.ok(COMMANDS.mcp);
  // npx skills: skills/<name>/SKILL.md with unique names, shipped in the npm package too.
  assert.ok(pkg.files.includes('skills/'));
});
