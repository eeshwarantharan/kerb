#!/usr/bin/env node
// Writes the expected results (<fixture>.expected.json) for test/fixtures/reporters/cases.json.
// Run after recording a new fixture, then review the diff: the goldens are what RP1–RP11 check.
//   node scripts/reporter-goldens.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseResults } from '../src/reporters/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test/fixtures/reporters');

export function runCase(c) {
  const file = path.join(DIR, c.fixture);
  const cmdFile = file.replace(/\.(txt|json|xml)$/, '.cmd');
  const command = c.command || (fs.existsSync(cmdFile) ? fs.readFileSync(cmdFile, 'utf8').trim() : '');
  if (!c.report) return parseResults({ command, text: fs.readFileSync(file, 'utf8'), cwd: c.root, root: c.root, deadline: Date.now() + 10_000 });
  // Report files are found through the command's --outputFile/--junitxml flag.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-rp-')), path.basename(file));
  fs.copyFileSync(file, tmp);
  try {
    return parseResults({ command: `tool --outputFile=${tmp}`, text: '', cwd: c.root, root: c.root, deadline: Date.now() + 10_000 });
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  for (const c of JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'))) {
    const out = path.join(DIR, `${c.fixture}.expected.json`);
    fs.writeFileSync(out, `${JSON.stringify(runCase(c), null, 2)}\n`);
    process.stdout.write(`wrote ${path.relative(ROOT, out)}\n`);
  }
}
