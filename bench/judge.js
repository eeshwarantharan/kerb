#!/usr/bin/env node
// Judge Kerb's refusals and cached answers in a finished benchmark run (KERB-V2 15: "refusals
// and cached answers, each judged correct or not"). A refusal that says "running this again
// can't change the result" (identical_retry, deja_vu, oscillating, cached) is replayed: the
// command runs twice in a worktree at the state the refusal was about, and the refusal is
// correct when both replays give the matched run's exit code. Replays that disagree with each
// other are "flaky" (left for a person). Policy and human-only refusals follow the repo's own
// policy and are labelled as such; breaker_open is a judgement call, left for a person.
//
//   node bench/judge.js <task dir> [--home <HOME used for the run>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Store, buildRuns } from '../src/store/jsonl.js';
import { worktreeAt, removeWorktree } from '../src/state/materialize.js';

const REPLAYED = new Set(['identical_retry', 'deja_vu', 'oscillating', 'cached']);
const BY_POLICY = new Set(['policy_blocked', 'human_only']);

function replay(cmd, cwd, env) {
  const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, env, stdio: 'ignore', timeout: 10 * 60_000 });
  return r.status;
}

/**
 * @param {string} root the task directory
 * @param {{ env?: NodeJS.ProcessEnv }} o
 * @returns {{ id: string, type: string, reason: string, cmd: string, correct: boolean | null, why: string }[]}
 */
export function judgeRun(root, o = {}) {
  const env = o.env || process.env;
  let recs = [];
  try { recs = new Store(root).read({ maxBytes: Number.MAX_SAFE_INTEGER, repair: false }); } catch { return []; }
  const runs = new Map(buildRuns(recs).filter((r) => r.finished).map((r) => [r.id, r]));
  const out = [];
  for (const r of recs) {
    if (r.type !== 'refusal' && r.type !== 'would_refuse' && r.type !== 'cached_answer') continue;
    const reason = r.type === 'cached_answer' ? 'cached' : r.reason;
    const row = { id: r.id, type: r.type, reason, cmd: r.cmd || null, correct: null, why: '' };
    out.push(row);
    if (BY_POLICY.has(reason)) { row.correct = true; row.why = 'follows the repo policy'; continue; }
    if (!REPLAYED.has(reason)) { row.why = 'a judgement call: review it'; continue; }
    const matched = runs.get(r.matched_run || r.source_run);
    if (!matched || !matched.post_hash || !r.cmd) { row.why = 'no matched run to replay'; continue; }
    const wt = worktreeAt(root, matched.post_hash, `judge-${r.id}`);
    if (!wt.ok) { row.why = `can't replay: ${wt.reason}`; continue; }
    try {
      const cwdRel = matched.key.slice(0, matched.key.indexOf('::'));
      const cwd = path.join(wt.dir, cwdRel === '.' ? '' : cwdRel);
      const a = replay(r.cmd, cwd, env);
      const b = replay(r.cmd, cwd, env);
      const want = matched.is_wait ? matched.final_exit : matched.exit;
      if (a !== b) { row.why = `replays disagree (exit ${a}, then ${b}): flaky, review it`; continue; }
      row.correct = a === want;
      row.why = row.correct ? `replayed twice: exit ${a}, as recorded` : `replayed twice: exit ${a}, but the recorded run exited ${want}`;
    } finally {
      removeWorktree(root, wt.dir);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  const i = args.indexOf('--home');
  const env = i === -1 ? process.env : { ...process.env, HOME: args[i + 1] };
  const rows = judgeRun(path.resolve(dir || '.'), { env });
  if (args.includes('--json')) console.log(JSON.stringify({ judged: rows }));
  else for (const r of rows) console.log(`${r.correct === true ? 'correct  ' : r.correct === false ? 'INCORRECT' : 'review   '} ${r.reason.padEnd(15)} ${r.cmd} · ${r.why}`);
}
