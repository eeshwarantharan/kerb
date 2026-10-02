#!/usr/bin/env node
// Task benchmark harness (KERB-V2 15; v1: docs/KERB.md 12.3): the same agent and model on every
// task, in four arms, several runs each.
//   plain   the agent as it is
//   skill   Kerb's rules as a skill and instructions only (bench/arms/skill-only.md), no hooks
//   v1      Kerb v1 (tag v0.1.0), hooks installed by its `kerb init`, enforce mode
//   v2      this Kerb, enforce mode, cause isolation on
//
//   node bench/run.js --agent-cmd 'claude -p {prompt} --output-format json --max-turns 40' \
//     [--arms plain,skill,v1,v2] [--tasks id,id] [--runs 3] [--out bench/results/tasks]
//     [--proxy http://127.0.0.1:8899] [--ca bench/results/tmp/ca/ca.pem] [--kerb-v1 <dir>]
//
// {prompt} is replaced with the shell-quoted prompt. The agent runs in the task directory and
// prints JSON with num_turns, usage and session_id (Claude Code's --output-format json does);
// with a Claude Code transcript, attempts, tokens and time to green are read from it
// (bench/transcript.js). --kerb-v1 is a checkout of tag v0.1.0 (bench/setup-v1.sh makes one).
// Tasks whose needs this machine can't meet are skipped and listed in the summary.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.js';
import { sandbox, available } from './sandbox.js';
import { readTranscript, greenMetrics, checkPattern } from './transcript.js';
import { judgeRun } from './judge.js';
import { judge as judgeFinding } from './cause.js';
import { analyze } from './analyze.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
export const ARMS = ['plain', 'skill', 'v1', 'v2'];

function main() {
  const agentCmd = opt('agent-cmd');
  if (!agentCmd) {
    console.error('usage: node bench/run.js --agent-cmd "<command with {prompt}>" [--arms …] [--tasks …] [--runs 3] [--proxy URL] [--ca file] [--kerb-v1 dir]');
    process.exit(64);
  }
  const runs = Number(opt('runs', 3));
  const arms = (opt('arms', ARMS.join(','))).split(',');
  const only = opt('tasks') ? opt('tasks').split(',') : null;
  const outDir = path.resolve(root, opt('out', 'bench/results/tasks'));
  const proxy = opt('proxy');
  const ca = opt('ca') ? path.resolve(opt('ca')) : null;
  const v1 = opt('kerb-v1') ? path.resolve(opt('kerb-v1')) : null;
  if (arms.includes('v1') && !v1) { console.error('the v1 arm needs --kerb-v1 <checkout of v0.1.0> (bench/setup-v1.sh)'); process.exit(64); }
  const have = available();
  if (proxy) have.add('npm-mirror').add('pypi-mirror');
  if (ca) have.add('tls-proxy');
  const tasks = TASKS.filter((t) => !only || only.includes(t.id));
  const skipped = tasks.filter((t) => (t.needs || []).some((n) => !have.has(n))).map((t) => ({ task: t.id, needs: t.needs }));
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const task of tasks.filter((t) => !skipped.some((s) => s.task === t.id))) {
    for (let n = 1; n <= runs; n++) {
      for (const arm of arms) {
        const row = runOnce(task, arm, n, { agentCmd, proxy, ca, v1 });
        rows.push(row);
        console.log(`${task.id} run ${n} ${arm}: ${row.success ? 'ok' : 'FAIL'} turns ${row.turns} tokens ${row.tokens} green ${row.attempts_to_green ?? '-'}/${row.tokens_to_green ?? '-'} ${Math.round(row.wall_ms / 1000)}s refusals ${row.refusals.length}`);
        fs.writeFileSync(path.join(outDir, 'rows.jsonl'), `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`);
      }
    }
  }
  const summary = { date: new Date().toISOString(), agent_cmd: agentCmd, runs, arms, tasks: tasks.length - skipped.length, skipped, ...analyze(rows) };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function kerbOf(arm, v1) {
  if (arm === 'v2') return [process.execPath, path.join(root, 'bin', 'kerb.js')];
  if (arm === 'v1') return [process.execPath, path.join(v1, 'bin', 'kerb.js')];
  return null;
}

/** Install an arm into a sandbox (and its HOME). */
function installArm(arm, dir, home, env, v1) {
  if (arm === 'skill') {
    const skill = fs.readFileSync(path.join(root, 'bench/arms/skill-only.md'), 'utf8');
    const rules = skill.replace(/^---[\s\S]*?---\n/, '');
    for (const p of ['.claude/skills/working-rules/SKILL.md', '.github/skills/working-rules/SKILL.md']) {
      fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), skill);
    }
    for (const p of ['AGENTS.md', 'CLAUDE.md']) fs.appendFileSync(path.join(dir, p), `\n${rules}`);
    return;
  }
  const kerb = kerbOf(arm, v1);
  if (!kerb) return;
  // Enforce mode (the shadow week is for people trying Kerb, not for measuring it).
  fs.mkdirSync(path.join(home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kerb', 'config.json'), JSON.stringify(arm === 'v2' ? { mode: 'enforce', cause: 'on' } : {}));
  spawnSync(kerb[0], [...kerb.slice(1), 'init'], { cwd: dir, env, stdio: 'ignore' });
}

/** The Claude Code transcript of a session, if it can be found. */
function transcriptOf(dir, sessionId) {
  if (!sessionId) return null;
  const f = path.join(os.homedir(), '.claude', 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);
  return fs.existsSync(f) ? f : null;
}

function kerbJson(kerb, dir, env, a) {
  if (!kerb) return null;
  const r = spawnSync(kerb[0], [...kerb.slice(1), ...a, '--json'], { cwd: dir, env, encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

function runOnce(task, arm, n, o) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-bench-home-')));
  const env = { ...process.env, HOME: home };
  if (o.proxy) Object.assign(env, { HTTPS_PROXY: o.proxy, HTTP_PROXY: o.proxy, https_proxy: o.proxy, http_proxy: o.proxy, NO_PROXY: 'localhost,127.0.0.1' });
  // Share the agent's login with the sandboxed HOME.
  for (const f of ['.claude', '.claude.json', '.codex', '.gemini', '.config']) {
    const src = path.join(os.homedir(), f);
    if (fs.existsSync(src)) try { fs.symlinkSync(src, path.join(home, f)); } catch { /* */ }
  }
  const box = sandbox(task, { ca: o.ca }, env);
  const dir = box.dir;
  installArm(arm, dir, home, env, o.v1);
  const kerb = kerbOf(arm, o.v1);
  if (task.edits) {
    // Seeded regressions: a green run before the edits, as in real work (through Kerb when it's there).
    if (kerb) spawnSync(kerb[0], [...kerb.slice(1), 'run', '--class', 'check', '--', task.test], { cwd: dir, env, stdio: 'ignore' });
    else box.sh(task.test, { env });
    task.edits(dir, box);
  }
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', ['-c', o.agentCmd.replace('{prompt}', q(task.prompt))], { cwd: dir, env, encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 1 << 28 });
  const wall = Date.now() - t0;
  let agent = {};
  try { agent = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  const success = spawnSync('/bin/sh', ['-c', task.check], { cwd: dir, env, timeout: 5 * 60_000 }).status === 0;
  const tf = transcriptOf(dir, agent.session_id);
  const g = tf ? greenMetrics(readTranscript(tf), checkPattern(task.test)) : null;
  const usage = agent.usage || {};
  // Kerb arms: refusals and cached answers (judged by replay), cause findings (judged against the seed).
  let refusals = [];
  let findings = [];
  let report = null;
  if (kerb) {
    refusals = judgeRun(dir, { env });
    if (arm === 'v2') {
      spawnSync(kerb[0], [...kerb.slice(1), 'worker', '--once'], { cwd: dir, env, stdio: 'ignore', timeout: 10 * 60_000 });
      const fq = kerbJson(kerb, dir, env, ['query', 'findings']);
      findings = ((fq && fq.findings) || []).map((f) => ({ test: f.test_id, confidence: f.confidence, locations: f.locations,
        ...(task.seeded ? judgeFinding(f, { control: false, culprits: { '*': task.seeded.culprits } }) : { counted: f.confidence === 'confirmed', correct: null }) }));
    }
    const rep = kerbJson(kerb, dir, env, ['report', '--since', '1d']);
    report = rep && rep.measured ? rep.measured : null;
  }
  const row = {
    task: task.id, category: task.category, lang: task.lang, arm, run: n, success, wall_ms: wall,
    turns: agent.num_turns ?? null,
    tokens: usage.input_tokens != null ? usage.input_tokens + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0) : null,
    cost_usd: agent.total_cost_usd ?? null,
    attempts: g ? g.attempts : null, attempts_to_green: g ? g.attempts_to_green : null, tokens_to_green: g ? g.tokens_to_green : null,
    ms_to_green: g ? g.ms_to_green : null, compactions: g ? g.compactions : null, transcript: tf,
    refusals, findings, hash_budget_skips: report ? report.hash_budget_skips ?? null : null,
    dir,
  };
  fs.rmSync(home, { recursive: true, force: true });
  return row;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
