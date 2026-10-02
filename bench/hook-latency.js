#!/usr/bin/env node
// Hook latency benchmark (v1 Z5, 12.3; KERB-V2 12): warm p50/p95, end to end (process start
// included), on a 5,000-file git repo: `kerb hook claude pre` for four kinds of command, `post`
// after a check with 50 test results, and `kerb statusline`. Each case has its section 12 budget.
//   node bench/hook-latency.js [--runs 50] [--out bench/results]
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kerb = process.env.KERB_BENCH_BIN ? [path.resolve(root, process.env.KERB_BENCH_BIN)] : [process.execPath, path.join(root, 'bin', 'kerb.js')];
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const runs = Number(opt('runs', 50));
const outDir = path.resolve(root, opt('out', 'bench/results'));

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-bench-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-bench-home-'));
for (let i = 0; i < 5000; i++) {
  const d = path.join(repo, 'src', `d${i % 50}`);
  if (i < 50) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `f${i}.js`), `export const v = ${i};\n`);
}
fs.writeFileSync(path.join(repo, 'package.json'), '{}');
fs.writeFileSync(path.join(repo, 'kerb.policy.json'), JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org' }] }));
const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
g('init', '-q'); g('add', '-A'); g('-c', 'user.name=b', '-c', 'user.email=b@e', 'commit', '-qm', 'bench');

const env = { ...process.env, HOME: home };
const cases = { query: 'ls src', check: 'npm test', 'check-after-failure': 'npm run lint', blocked: 'npm install left-pad' };
// Give "npm run lint" a recorded failure, so its pre hook has to hash the workspace.
{
  const p = { session_id: 'bench', cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm run lint' }, tool_use_id: 'seed' };
  spawnSync(kerb[0], [...kerb.slice(1), 'hook', 'claude', 'pre'], { input: JSON.stringify(p), env: { ...process.env, HOME: home }, cwd: repo });
  spawnSync(kerb[0], [...kerb.slice(1), 'hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p, error: 'Exit code 1\nlint failed' }), env: { ...process.env, HOME: home }, cwd: repo });
  fs.writeFileSync(path.join(repo, 'src', 'd0', 'f0.js'), 'export const v = -1;\n');
}
const result = { date: new Date().toISOString(), load_average: os.loadavg().map((x) => +x.toFixed(2)), kerb: process.env.KERB_BENCH_BIN ? path.basename(process.env.KERB_BENCH_BIN) : `bin/kerb.js on node ${process.version}`, harness_node: process.version, platform: `${process.platform}-${process.arch}`, cpus: os.cpus().length, files: 5000, runs, cases: {} };
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const [name, command] of Object.entries(cases)) {
  const times = [];
  for (let i = 0; i < runs + 3; i++) {
    const payload = JSON.stringify({ session_id: 'bench', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `b${name}${i}` });
    const t0 = process.hrtime.bigint();
    spawnSync(kerb[0], [...kerb.slice(1), 'hook', 'claude', 'pre'], { input: payload, env, cwd: repo, stdio: ['pipe', 'ignore', 'ignore'] });
    if (i >= 3) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  result.cases[name] = { p50_ms: +pct(times, 0.5).toFixed(1), p95_ms: +pct(times, 0.95).toFixed(1), min_ms: +times[0].toFixed(1) };
}
// PostToolUse after a check: record, state, classify, parse 50 results, delta.
{
  const out = ['============================= test session starts ==============================', ''];
  for (let i = 0; i < 50; i++) out.push(`tests/test_app.py::test_${i} ${i % 10 === 3 ? 'FAILED' : 'PASSED'}`);
  out.push('========================= 5 failed, 45 passed in 0.31s =========================');
  const times = [];
  for (let i = 0; i < runs + 3; i++) {
    const p = { session_id: 'bench', cwd: repo, tool_name: 'Bash', tool_input: { command: 'pytest -v' }, tool_use_id: `post${i}` };
    spawnSync(kerb[0], [...kerb.slice(1), 'hook', 'claude', 'pre'], { input: JSON.stringify(p), env, cwd: repo, stdio: ['pipe', 'ignore', 'ignore'] });
    const t0 = process.hrtime.bigint();
    spawnSync(kerb[0], [...kerb.slice(1), 'hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p, error: `Exit code 1\n${out.join('\n')}` }), env, cwd: repo, stdio: ['pipe', 'ignore', 'ignore'] });
    if (i >= 3) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    fs.writeFileSync(path.join(repo, 'src', 'd1', 'f1.js'), `export const v = ${i};\n`); // a new state each time
  }
  times.sort((a, b) => a - b);
  result.cases.post = { p50_ms: +pct(times, 0.5).toFixed(1), p95_ms: +pct(times, 0.95).toFixed(1), min_ms: +times[0].toFixed(1) };
}
{
  const times = [];
  for (let i = 0; i < runs + 3; i++) {
    const t0 = process.hrtime.bigint();
    spawnSync(kerb[0], [...kerb.slice(1), 'statusline'], { input: JSON.stringify({ session_id: 'bench', cwd: repo }), env, cwd: repo, stdio: ['pipe', 'ignore', 'ignore'] });
    if (i >= 3) times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  result.cases.statusline = { p50_ms: +pct(times, 0.5).toFixed(1), p95_ms: +pct(times, 0.95).toFixed(1), min_ms: +times[0].toFixed(1) };
}
const base = [];
for (let i = 0; i < runs; i++) { const t0 = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' }); base.push(Number(process.hrtime.bigint() - t0) / 1e6); }
base.sort((a, b) => a - b);
result.node_startup = { p50_ms: +pct(base, 0.5).toFixed(1), p95_ms: +pct(base, 0.95).toFixed(1) };
// Section 12 budgets (KERB-V2): pre 60 ms for other commands, 120 ms for checks; post 150 ms; status line 50 ms.
const BUDGETS = { query: 60, blocked: 60, check: 120, 'check-after-failure': 120, post: 150, statusline: 50 };
for (const [k, c] of Object.entries(result.cases)) { c.budget_ms = BUDGETS[k]; c.within_budget = c.p95_ms <= BUDGETS[k]; }
result.latency_gate = { budgets: 'KERB-V2 section 12', pass: Object.values(result.cases).every((c) => c.within_budget) };
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `hook-latency-${result.platform}-${process.env.KERB_BENCH_BIN ? 'binary' : 'npm'}.json`);
fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(home, { recursive: true, force: true });
console.log(JSON.stringify(result, null, 2));
console.log(`wrote ${path.relative(root, file)}`);
