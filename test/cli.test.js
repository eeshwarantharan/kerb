import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runKerb, ROOT } from './helpers.js';
import { VERSION } from '../src/version.js';

test('T0 --help prints usage', () => {
  const r = runKerb(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: kerb <command>/);
});

test('T0 --version matches package.json', () => {
  const r = runKerb(['--version']);
  assert.equal(r.code, 0);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(r.stdout.trim(), pkg.version);
  assert.equal(VERSION, pkg.version);
});

test('T0 unknown command exits 64', () => {
  const r = runKerb(['frobnicate']);
  assert.equal(r.code, 64);
  assert.match(r.stderr, /unknown command/);
});

test('T0 --json prints exactly one JSON object for help, version and errors', () => {
  for (const args of [['--json', '--help'], ['--version', '--json'], ['--json', 'frobnicate']]) {
    const r = runKerb(args);
    assert.equal(r.stdout.trim().split('\n').length, 1, `one line for ${args}`);
    assert.equal(typeof r.json, 'object');
    assert.ok(r.json);
  }
});

test('Z4 package.json has no dependencies or devDependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

import { makeRepo } from './helpers.js';
import { COMMANDS } from '../src/cli/main.js';

test('T0 every command supports --json and prints exactly one JSON object', () => {
  const repo = makeRepo({ git: true, files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) } });
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  repo.kerb(['run', '--class', 'check', '--', 'exit 1']);
  const ids = repo.kerb(['history', '--json']).json.entries.filter((e) => e.kind === 'run').map((e) => e.id);
  const cases = {
    run: ['run', '--', 'echo hi'],
    'wait-for': ['wait-for', '--max', '2s', '--', 'true'],
    check: ['check', '--', 'docker ps'],
    init: ['init', '--agent', 'other', '--dry-run'],
    uninstall: ['uninstall'],
    doctor: ['doctor'],
    status: ['status'],
    why: ['why'],
    history: ['history'],
    diff: ['diff', ids[0], ids[1] || ids[0]],
    map: ['map'],
    report: ['report'],
    recap: ['recap'],
    statusline: ['statusline'],
    card: ['card', '--out', repo.home],
    ack: ['ack'],
    reset: ['reset'],
    forget: ['forget', 'x.example'],
    policy: ['policy', 'lint'],
    'export-denials': ['export-denials'],
    review: ['review', '--denials', '/nonexistent/file.jsonl'],
    config: ['config', 'get'],
  };
  const skipped = new Set(['watch', 'hook']); // watch streams events; hook speaks each agent's protocol
  for (const name of Object.keys(COMMANDS)) {
    if (skipped.has(name)) continue;
    assert.ok(cases[name], `a --json case for ${name}`);
    const r = repo.kerb(['--json', ...cases[name]], { input: '' });
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1, `${name}: ${r.stdout}`);
    assert.equal(typeof JSON.parse(lines[0]), 'object', name);
  }
});
