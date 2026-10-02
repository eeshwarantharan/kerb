#!/usr/bin/env node
// A checkout of Kerb v1 (tag v0.1.0) for the benchmark's v1 arm, as a git worktree.
//   node bench/setup-v1.js [dir]     (default: bench/results/tmp/kerb-v1)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(root, 'bench/results/tmp/kerb-v1'));
if (fs.existsSync(path.join(dir, 'bin', 'kerb.js'))) {
  console.log(`already there: ${dir}`);
} else {
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', dir, 'v0.1.0'], { stdio: 'inherit' });
  console.log(`Kerb v1 at ${dir}; pass --kerb-v1 ${path.relative(process.cwd(), dir)} to bench/run.js`);
}
