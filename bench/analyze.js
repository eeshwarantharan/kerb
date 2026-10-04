#!/usr/bin/env node
// Benchmark analysis and the 1.0 launch gate (KERB-V2 15).
//
//   node bench/analyze.js [bench/results/tasks/rows.jsonl] [--cause bench/results/cause/summary.json]
//                         [--latency bench/results/hook-latency-<platform>-<build>.json]
//
// Gate:
//   1. success rate of v2 no lower than plain (within 1 point)
//   2. v2 beats skill on tokens to green or time to green, the 95% CI of the paired difference
//      excluding zero (bootstrap over (task, run) pairs where both arms reached green)
//   3. zero incorrect refusals or cached answers (bench/judge.js; unjudged ones are listed)
//   4. cause findings: precision >= 95% among confirmed findings
//   5. hook latency within the section 12 budgets
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGETS_MS = { query: 60, blocked: 60, check: 120, 'check-after-failure': 120, post: 150, statusline: 50 };

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** Mean and 95% bootstrap CI of a list of differences (deterministic). */
export function bootstrap(diffs, n = 4000, seed = 7) {
  if (!diffs.length) return null;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const r = rng(seed);
  const means = [];
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < diffs.length; j++) s += diffs[Math.floor(r() * diffs.length)];
    means.push(s / diffs.length);
  }
  means.sort((a, b) => a - b);
  return { n: diffs.length, mean: mean(diffs), lo: means[Math.floor(n * 0.025)], hi: means[Math.floor(n * 0.975)] };
}

export function armSummary(rows, arm) {
  const rs = rows.filter((r) => r.arm === arm);
  const med = (k) => { const v = rs.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
  const sum = (k) => rs.reduce((s, r) => s + (r[k] || 0), 0);
  return {
    runs: rs.length,
    success_rate: rs.length ? rs.filter((r) => r.success).length / rs.length : null,
    reached_green: rs.filter((r) => r.attempts_to_green != null).length,
    median_attempts_to_green: med('attempts_to_green'), median_tokens_to_green: med('tokens_to_green'), median_ms_to_green: med('ms_to_green'),
    tokens: sum('tokens'), wall_ms: sum('wall_ms'), cost_usd: +sum('cost_usd').toFixed(2),
    refusals: rs.reduce((n, r) => n + (r.refusals || []).length, 0),
    // Refusals followed by the same failing tests run another way.
    worked_around: rs.reduce((n, r) => n + (r.workarounds || 0), 0),
  };
}

/** Paired differences skill − v2 (positive: v2 used less). */
function paired(rows, a, b, key) {
  const by = new Map();
  for (const r of rows) if (r.arm === a || r.arm === b) by.set(`${r.task}\0${r.run}\0${r.arm}`, r);
  const diffs = [];
  for (const r of rows.filter((x) => x.arm === a)) {
    const o = by.get(`${r.task}\0${r.run}\0${b}`);
    if (o && r[key] != null && o[key] != null) diffs.push(r[key] - o[key]);
  }
  return diffs;
}

export function analyze(rows, o = {}) {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const per = Object.fromEntries(arms.map((a) => [a, armSummary(rows, a)]));
  const judged = rows.filter((r) => r.arm === 'v2' || r.arm === 'v1').flatMap((r) => (r.refusals || []).map((x) => ({ ...x, arm: r.arm, task: r.task, run: r.run })));
  const findings = rows.filter((r) => r.arm === 'v2').flatMap((r) => (r.findings || []).filter((f) => f.counted && f.correct != null));
  const tok = paired(rows, 'skill', 'v2', 'tokens_to_green');
  const time = paired(rows, 'skill', 'v2', 'ms_to_green');
  const ciTok = bootstrap(tok);
  const ciTime = bootstrap(time);
  const v2 = per.v2 || {};
  const plain = per.plain || {};
  const causeBench = o.cause || null;
  const confirmed = findings.length + (causeBench ? causeBench.confirmed_findings : 0);
  const correct = findings.filter((f) => f.correct).length + (causeBench ? causeBench.correct_findings : 0);
  const latency = o.latency || null;
  const latencyRows = latency ? Object.entries(latency.cases).filter(([k]) => BUDGETS_MS[k]).map(([k, c]) => ({ case: k, p95_ms: c.p95_ms, budget_ms: BUDGETS_MS[k], pass: c.p95_ms <= BUDGETS_MS[k] })) : [];
  const gate = {
    success_within_1_point: v2.success_rate != null && plain.success_rate != null ? v2.success_rate >= plain.success_rate - 0.01 : null,
    beats_skill: ciTok || ciTime ? !!((ciTok && ciTok.lo > 0) || (ciTime && ciTime.lo > 0)) : null,
    zero_incorrect_refusals: judged.some((j) => j.correct === false) ? false : judged.some((j) => j.correct == null) ? null : true,
    cause_precision_95: confirmed ? correct / confirmed >= 0.95 : null,
    hook_latency_within_budget: latencyRows.length ? latencyRows.every((r) => r.pass) : null,
  };
  return {
    per_arm: per,
    skill_minus_v2: { tokens_to_green: ciTok, ms_to_green: ciTime },
    refusals: { judged: judged.length, correct: judged.filter((j) => j.correct === true).length, incorrect: judged.filter((j) => j.correct === false), to_review: judged.filter((j) => j.correct == null).map((j) => ({ task: j.task, arm: j.arm, reason: j.reason, cmd: j.cmd, why: j.why })) },
    cause: { confirmed, correct, precision: confirmed ? correct / confirmed : null, from_runs: findings.length, from_cause_bench: causeBench ? causeBench.confirmed_findings : 0 },
    latency: latencyRows,
    launch_gate: { ...gate, pass: Object.values(gate).every((v) => v === true) },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? null : args[i + 1]; };
  const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))) || 'bench/results/tasks/rows.jsonl';
  const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const read = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
  const out = analyze(rows, { cause: read(opt('cause')), latency: read(opt('latency')) });
  console.log(JSON.stringify({ rows: rows.length, source: path.resolve(file), ...out }, null, 2));
}
