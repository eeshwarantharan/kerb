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
