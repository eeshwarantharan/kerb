#!/usr/bin/env node
// A scripted stand-in for an agent, used only to test the harness plumbing: it runs the task's
// test command the way a naive agent does (twice, through kerb run), then prints Claude-style JSON.
// Its numbers mean nothing about real agents and must never be reported.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const kerb = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'kerb.js');
let turns = 0;
for (let i = 0; i < 2; i++) {
  turns++;
  spawnSync(process.execPath, [kerb, 'run', '--', 'npm test'], { stdio: 'ignore' });
}
console.log(JSON.stringify({ num_turns: turns, usage: { input_tokens: 100 * turns, output_tokens: 10 * turns }, total_cost_usd: 0 }));
