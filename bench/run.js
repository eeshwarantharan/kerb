#!/usr/bin/env node
// Task benchmark harness (docs/KERB.md 12.3): the same agent and model on every task, with and
// without Kerb, several runs each. Records success, turns, tokens, wall time, refusals (for manual
// correctness review), hash-budget skips; hook latency comes from bench/hook-latency.js.
//
//   node bench/run.js --agent-cmd 'claude -p {prompt} --output-format json --max-turns 30' \
//     [--tasks id,id] [--runs 3] [--out bench/results/tasks] [--proxy http://127.0.0.1:8899]
//
// {prompt} is replaced with the shell-quoted prompt. The agent must run in the task directory
// and print JSON with num_turns and usage (Claude Code's --output-format json does). For the
// restrictive egress allowlist, start bench/proxy.js and pass --proxy.
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const agentCmd = opt('agent-cmd');
if (!agentCmd) {
  console.error('usage: node bench/run.js --agent-cmd "<command with {prompt}>" [--tasks …] [--runs 3] [--proxy URL]');
  process.exit(64);
}
const runs = Number(opt('runs', 3));
const only = opt('tasks') ? opt('tasks').split(',') : null;
const outDir = path.resolve(root, opt('out', 'bench/results/tasks'));
const proxy = opt('proxy');
const kerb = [process.execPath, path.join(root, 'bin', 'kerb.js')];
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function sandbox(task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kerb-bench-${task.id}-`));
  task.setup(dir);
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('add', '-A');
  g('-c', 'user.name=bench', '-c', 'user.email=bench@example.com', 'commit', '-qm', 'task');
  return dir;
}

function runOnce(task, withKerb, n) {
  const dir = sandbox(task);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-bench-home-'));
  const env = { ...process.env, HOME: home };
  if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: 'localhost,127.0.0.1' });
  // Share the agent's login with the sandboxed HOME.
  for (const f of ['.claude', '.claude.json', '.codex', '.gemini', '.config']) {
    const src = path.join(os.homedir(), f);
    if (fs.existsSync(src)) try { fs.symlinkSync(src, path.join(home, f)); } catch { /* */ }
  }
  if (withKerb) spawnSync(kerb[0], [...kerb.slice(1), 'init'], { cwd: dir, env, stdio: 'ignore' });
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', ['-c', agentCmd.replace('{prompt}', q(task.prompt))], { cwd: dir, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 1 << 28 });
  const wall = Date.now() - t0;
  let agent = {};
  try { agent = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  const success = spawnSync('/bin/sh', ['-c', task.check], { cwd: dir, env, timeout: 5 * 60_000 }).status === 0;
  let report = null;
  let refusals = [];
  if (withKerb) {
    const rep = spawnSync(kerb[0], [...kerb.slice(1), 'report', '--json', '--since', '1d'], { cwd: dir, env, encoding: 'utf8' });
    try { report = JSON.parse(rep.stdout).measured; } catch { /* */ }
    const h = spawnSync(kerb[0], [...kerb.slice(1), 'history', '--json', '-n', '500'], { cwd: dir, env, encoding: 'utf8' });
    try { refusals = JSON.parse(h.stdout).entries.filter((e) => e.kind === 'refusal').map((e) => ({ reason: e.reason, cmd: e.cmd, correct: null })); } catch { /* */ }
  }
  const usage = agent.usage || {};
  const row = {
    task: task.id, category: task.category, kerb: withKerb, run: n, success, wall_ms: wall,
    turns: agent.num_turns ?? null,
    input_tokens: usage.input_tokens != null ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) : null,
    output_tokens: usage.output_tokens ?? null,
    cost_usd: agent.total_cost_usd ?? null,
    refusals,
    hash_budget_skips: report ? report.hash_budget_skips : null,
    dir,
  };
  fs.rmSync(home, { recursive: true, force: true });
  return row;
}

fs.mkdirSync(outDir, { recursive: true });
const rows = [];
const tasks = TASKS.filter((t) => !only || only.includes(t.id));
for (const task of tasks) {
  for (let n = 1; n <= runs; n++) {
    for (const withKerb of [false, true]) {
      const row = runOnce(task, withKerb, n);
      rows.push(row);
      console.log(`${task.id} run ${n} ${withKerb ? 'kerb' : 'bare'}: ${row.success ? 'ok' : 'FAIL'} turns ${row.turns} in ${row.input_tokens} out ${row.output_tokens} ${Math.round(row.wall_ms / 1000)}s refusals ${row.refusals.length}`);
      fs.writeFileSync(path.join(outDir, 'rows.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
    }
  }
}

const agg = (k) => {
  const rs = rows.filter((r) => r.kerb === k);
  const sum = (f) => rs.reduce((n, r) => n + (r[f] || 0), 0);
  return { runs: rs.length, success_rate: rs.length ? rs.filter((r) => r.success).length / rs.length : null, turns: sum('turns'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), wall_ms: sum('wall_ms'), refusals: rs.reduce((n, r) => n + r.refusals.length, 0) };
};
const summary = { date: new Date().toISOString(), agent_cmd: agentCmd, tasks: tasks.length, runs, without: agg(false), with: agg(true) };
summary.launch_gate = {
  success_within_1_point: summary.with.success_rate != null && summary.without.success_rate != null && summary.with.success_rate >= summary.without.success_rate - 0.01,
  incorrect_refusals: 'review refusals in rows.jsonl and set "correct" for each; the gate needs zero incorrect',
};
fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
