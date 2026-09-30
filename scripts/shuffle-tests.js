#!/usr/bin/env node
// Run the test suite several times with the test files in a shuffled order, one file at a
// time, to shake out order dependence and flakes (build step 7.1).
//   node scripts/shuffle-tests.js [--runs 10] [--seed 42]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i === -1 ? d : Number(args[i + 1]); };
const runs = opt('runs', 10);
let seed = opt('seed', Date.now() % 100000);

function rand() { // mulberry32
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const files = fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => path.join('test', f));
let failed = 0;
console.log(`seed ${seed}, ${files.length} files, ${runs} runs`);
for (let r = 1; r <= runs; r++) {
  const order = [...files];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const t0 = Date.now();
  const res = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...order], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = `${res.stdout}${res.stderr}`;
  const pass = /# pass (\d+)/.exec(out);
  const fail = /# fail (\d+)/.exec(out);
  const nfail = fail ? Number(fail[1]) : 1;
  console.log(`run ${r}: pass ${pass ? pass[1] : '?'} fail ${nfail} (${Math.round((Date.now() - t0) / 1000)}s)`);
  if (nfail) {
    failed++;
    for (const line of out.split('\n')) if (/^not ok/.test(line)) console.log(`  ${line}`);
  }
}
process.exit(failed ? 1 : 0);
