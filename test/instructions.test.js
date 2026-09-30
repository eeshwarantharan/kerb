import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo } from './helpers.js';
import { SKILL, instructionsBlock } from '../src/init/instructions.js';

const block = (text) => text.slice(text.indexOf('<!-- kerb:start -->'), text.indexOf('<!-- kerb:end -->') + '<!-- kerb:end -->'.length);

test('N1 the block is written between markers; a re-run updates it in place', () => {
  const repo = makeRepo({ git: true, files: { 'AGENTS.md': '# Agents\n\nBe careful.\n' } });
  repo.kerb(['init', '--agent', 'other']);
  const first = repo.read('AGENTS.md');
  assert.match(first, /^# Agents\n\nBe careful\.\n\n<!-- kerb:start -->\n## Running commands with Kerb[\s\S]*<!-- kerb:end -->\n$/);
  assert.match(first, /Known boundaries here:\n- none known yet/);
  repo.write('kerb.policy.json', JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker', why: 'Docker is not available here.' }] }));
  repo.kerb(['init', '--agent', 'other']);
  const second = repo.read('AGENTS.md');
  assert.equal(second.split('<!-- kerb:start -->').length, 2, 'one block');
  assert.match(block(second), /- the docker command: Docker is not available here/);
  assert.ok(second.startsWith('# Agents\n\nBe careful.\n'));
});

test('N2 the briefing is at most 10 lines and 300 tokens, most-hit first', () => {
  const boundaries = Array.from({ length: 25 }, (_, i) => ({ kind: 'host', pattern: `h${i}.example.com`, why: `Blocked for reason number ${i}, which is explained at some length here.`, alternative: `https://mirror${i}.corp.internal/path` }));
  const repo = makeRepo({ git: true, files: { 'kerb.policy.json': JSON.stringify({ boundaries }) } });
  for (let i = 0; i < 3; i++) repo.kerb(['run', '--', 'curl https://h20.example.com/x']);
  repo.kerb(['init', '--agent', 'other']);
  const lines = block(repo.read('AGENTS.md')).split('Known boundaries here:\n')[1].split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length <= 10, `${lines.length} lines`);
  assert.ok(Buffer.byteLength(lines.join('\n')) <= 300 * 4);
  assert.match(lines[0], /h20\.example\.com/, 'most-hit first');
});

test('N3 the briefing is regenerated on a new confirmed boundary', () => {
  const repo = makeRepo({ git: true, files: { curl: '#!/bin/sh\necho "blocked by policy: a.example"\nexit 56\n' } });
  fs.chmodSync(path.join(repo.dir, 'curl'), 0o755);
  repo.kerb(['init', '--agent', 'other']);
  assert.ok(!repo.read('AGENTS.md').includes('a.example'));
  repo.kerb(['run', '--', './curl https://a.example/x']);
  assert.match(repo.read('AGENTS.md'), /- a\.example: blocked here \(learned from a policy denial\)/);
});

test('N4 CLAUDE.md, GEMINI.md and copilot-instructions.md only when they exist; AGENTS.md always', () => {
  const bare = makeRepo({ git: true });
  bare.kerb(['init', '--agent', 'other']);
  assert.ok(bare.exists('AGENTS.md'));
  for (const f of ['CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) assert.equal(bare.exists(f), false, f);
  const full = makeRepo({ git: true, files: { 'CLAUDE.md': 'c\n', 'GEMINI.md': 'g\n', '.github/copilot-instructions.md': 'p\n' } });
  full.kerb(['init', '--agent', 'other']);
  for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) assert.match(full.read(f), /<!-- kerb:start -->/, f);
});

test('N5 instructions tell agents to trust the kerb: line over exit codes', () => {
  assert.match(instructionsBlock([]), /Trust the `kerb:` line, not the exit code alone\./);
  assert.match(SKILL, /Trust the `kerb:` line, not the exit code alone\./);
});

test('N6 instructions and skill tell agents to use kerb wait-for for polling', () => {
  assert.match(instructionsBlock([]), /kerb wait-for --max 3m -- <command>/);
  assert.match(SKILL, /kerb wait-for --max 3m -- <command>/);
  assert.equal(SKILL.split('\n')[0], '---');
});
