// Same result, another command (KERB-V2 4.7, 7.1). No parser sees inside every program: an agent
// refused for re-running `npm test` can run the same tests through `python3 -c "subprocess…"`,
// a Makefile target or a new script. The output is the ground truth: when a run fails exactly the
// tests that a recent check failed, and that check's own files are as they were then, it was the
// same run. Kerb tells the agent at once, records it, and counts it for the person
// (`kerb recap`, `kerb report`), so working around a refusal is visible and never pays.
import fs from 'node:fs';
import { newId, now } from '../util/core.js';
import { buildRuns } from '../store/jsonl.js';
import { readState, diffStates } from '../state/keep.js';
import { snapshotPath } from '../loop/workspace.js';
import { currentState } from './verify.js';
import { isFailure } from '../loop/outcome.js';
import { keyCommand, endTs } from './history.js';

export const WINDOW_MS = 30 * 60_000;
const LOOP_REASONS = new Set(['identical_retry', 'deja_vu', 'oscillating', 'breaker_open', 'cached']);
/** Files that can appear between the two runs without changing a test result: the script itself. */
const SCRIPT_FILE = /\.(sh|bash|zsh)$/;

/**
 * Paths that differ between a kept state and the current one (null when they can't be compared):
 * git trees through `git diff`, walk-mode states by their file hashes.
 */
export function changedPaths(root, a, b) {
  if (!a || !b || a.mode !== b.mode) return null;
  if (a.mode === 'git') return a.tree && b.tree ? diffStates(root, a, b) : null;
  if (!a.files || !b.files) return null;
  return [...new Set([...Object.keys(a.files), ...Object.keys(b.files)])].filter((k) => JSON.stringify(a.files[k]) !== JSON.stringify(b.files[k]));
}

/** Is `current` (a state from currentState) the state `run` ended in, apart from shell scripts written since? */
export function onlyScriptsChanged(prep, run, current) {
  let old = readState(prep.root, run.post_hash);
  if (!old) try { old = JSON.parse(fs.readFileSync(snapshotPath(prep.store, run.id), 'utf8')); } catch { return false; }
  const changed = changedPaths(prep.root, old, current);
  // Called only when the state ids differ: no changed path found means the difference is
  // elsewhere (the environment), so it isn't "only scripts".
  return Array.isArray(changed) && changed.length > 0 && changed.every((f) => SCRIPT_FILE.test(f));
}

const failingSet = (recs, runId) => new Set(recs.filter((r) => r.type === 'test_result' && r.run === runId && r.status === 'fail').map((r) => r.test_id));
const sameSet = (a, b) => a.size > 0 && a.size === b.size && [...a].every((x) => b.has(x));

/**
 * @param {any} prep engine prep
 * @param {any[]} recs the event log, including this run
 * @param {string} runId
 * @returns {{ line: string, rec: any } | null}
 */
export function sameResultElsewhere(prep, recs, runId) {
  const runs = buildRuns(recs).filter((r) => r.finished);
  const run = runs.find((r) => r.id === runId);
  if (!run || !isFailure(run)) return null;
  const failing = failingSet(recs, runId);
  if (!failing.size) return null;
  const t = endTs(run);
  // The most recent other check that failed the same tests in the window.
  const other = runs.filter((r) => r.key !== run.key && r.id !== runId && isFailure(r) && r.post_hash && t - endTs(r) <= WINDOW_MS && endTs(r) <= t)
    .sort((a, b) => endTs(b) - endTs(a))
    .find((r) => sameSet(failing, failingSet(recs, r.id)));
  if (!other) return null;
  // Nothing relevant changed for that check: its scope is as it was (a new shell script aside).
  let unchanged = false;
  try {
    const cur = currentState(prep.root, prep.git, other.key, prep.policy, prep.ctx.env);
    if (cur.hash && cur.hash === other.post_hash) unchanged = true;
    else if (cur.snapshot) unchanged = onlyScriptsChanged(prep, other, cur.snapshot);
  } catch { return null; }
  if (!unchanged) return null;
  const refusal = recs.filter((r) => r.type === 'refusal' && r.key === other.key && LOOP_REASONS.has(r.reason) && r.ts >= endTs(other) && r.ts <= t).pop() || null;
  const cmd = other.cmd || keyCommand(other.key);
  const at = new Date(refusal ? refusal.ts : endTs(other)).toTimeString().slice(0, 5);
  const n = failing.size;
  const first = run.first_fail_line ? ` · ${run.first_fail_line.slice(0, 120)}` : '';
  const line = refusal
    ? `kerb: same result · this failed the same ${n} test${n === 1 ? '' : 's'} as \`${cmd}\`, refused at ${at} because nothing had changed${first} · running the tests another way can't change the result: change the code first`
    : `kerb: same result · the same ${n} failing test${n === 1 ? '' : 's'} as \`${cmd}\` at ${at}, and nothing it depends on has changed since${first}`;
  return {
    line,
    rec: { type: 'workaround', id: newId(), ts: now(), run: runId, key: run.key, same_as: other.id, same_key: other.key, refusal: refusal ? refusal.id : null, after_refusal: !!refusal,
      avoided_ms: refusal && refusal.matched_run ? refusal.avoided_duration_ms || 0 : 0, avoided_bytes: refusal && refusal.matched_run ? refusal.avoided_output_bytes || 0 : 0, failing: n, session: prep.session },
  };
}
