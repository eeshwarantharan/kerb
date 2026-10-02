// What a finished run sets off (KERB-V2 7.6, 8.1, 8.2): record a proven fix, queue a cause or a
// minimisation job for the worker, and deliver findings the worker has produced.
import { readState } from '../state/keep.js';
import { keyRuns, testsByRun, flakyTests, keyCommand } from './history.js';
import { fixFor, fixHint, attachCommits, writeNotes } from './fixes.js';
import { isHermetic } from './cache.js';
import { enqueue } from '../worker/queue.js';
import { ensureWorker, workerEnabled } from '../worker/main.js';

const FAILING = new Set(['fail', 'error']);

/** May the worker run this key's command in the background? Static checks: yes; tests: once a human said so. */
export function backgroundAllowed(prep) {
  if (!workerEnabled(prep.config, prep.ctx.env)) return false;
  return isHermetic(prep.parsed, prep.policy) || prep.config.values.cause === 'on';
}

/**
 * The newest earlier run of the key where `testId` passed on a kept state.
 * @returns {{ run: any, state: any } | null}
 */
function lastPass(recs, runs, byRun, testId, before) {
  for (let i = before - 1; i >= 0; i--) {
    const t = (byRun.get(runs[i].id) || []).find((x) => x.test_id === testId);
    if (t && t.status === 'pass') {
      const state = readState(runs[i].root || '', runs[i].post_hash);
      return { run: runs[i], stateId: runs[i].post_hash, state };
    }
  }
  return null;
}

/**
 * @param {any} prep the run's engine prep
 * @param {any[]} recs the event log, including the run
 * @param {string} runId
 * @returns {{ hints: string[], records: any[] }}
 */
export function afterRun(prep, recs, runId) {
  const out = { hints: [], records: [] };
  const end = recs.find((r) => r.type === 'end' && r.id === runId);
  if (!end || end.class !== 'check' || end.exit == null) return out;
  const allowed = backgroundAllowed(prep);
  let queued = false;
  // A failure that turned green: a proven fix, minimised later by the worker.
  const fix = fixFor(prep.root, recs, runId);
  if (fix) {
    out.records.push(fix);
    if (allowed && fix.test_ids.length) queued = !!enqueue(prep.root, 'minimize', { fix_id: fix.id, command: keyCommand(end.key), cwd_rel: end.key.slice(0, end.key.indexOf('::')) }, { dedupe: fix.id }) || queued;
  }
  if (end.exit !== 0) {
    const hint = fixHint(recs, runId);
    if (hint) out.hints.push(hint);
    // A test that passed before and fails now: isolate the cause (8.2).
    const runs = keyRuns(recs, end.key);
    const i = runs.findIndex((r) => r.id === runId);
    const byRun = testsByRun(recs);
    const flaky = flakyTests(recs);
    const bad = readState(prep.root, end.post_hash);
    if (i > 0 && bad && bad.materializable && bad.mode === 'git') {
      for (const t of (byRun.get(runId) || []).filter((x) => FAILING.has(x.status) && !flaky.has(x.test_id))) {
        const g = lastPass(recs, runs.map((r) => ({ ...r, root: prep.root })), byRun, t.test_id, i);
        if (!g || !g.stateId || g.stateId === bad.id) continue;
        const good = readState(prep.root, g.stateId);
        if (!good || !good.materializable || good.env_stamp !== bad.env_stamp) continue;
        if (!allowed) {
          if (!prep.store.dir || !workerEnabled(prep.config, prep.ctx.env)) break;
          prep.store.updateSummary((s) => { if (!s.cause_offered) s.cause_offer = { test: t.test_id, ts: Date.now() }; });
          break;
        }
        const attempt = runs.slice(0, i + 1).filter((r) => r.exit !== 0 || r.id === runId).length;
        const job = enqueue(prep.root, 'cause', {
          key: end.key, test_id: t.test_id, good_state: good.id, bad_state: bad.id, good_run: g.run.id, bad_run: runId,
          command: keyCommand(end.key), cwd_rel: end.key.slice(0, end.key.indexOf('::')), attempt,
        }, { dedupe: `${end.key}\0${t.test_id}\0${bad.id}` });
        queued = queued || !!job;
        break; // one cause job per run
      }
    }
  }
  if (out.records.length) prep.store.append(out.records);
  if (queued) ensureWorker(prep.root, prep.config, prep.ctx.env);
  return out;
}

/** After `git commit`: attach commits to fixes, and write notes when sharing is on (7.6, 7.7). */
export function afterCommit(prep, recs) {
  const updated = attachCommits(prep.root, recs);
  if (!updated.length) return 0;
  prep.store.append(updated);
  if (prep.config.values.share_fixes === true) writeNotes(prep.root, updated);
  return updated.length;
}

const testName = (id) => { const i = id.indexOf('::'); return i === -1 ? id : id.slice(i + 2); };

/** The context block for a finding (8.2). */
export function findingLines(f) {
  const name = `"${testName(f.test_id)}"`;
  if (f.confidence === 'confirmed') {
    const n = f.culprit_hunks.length;
    return [
      `kerb: cause · ${name} broke${f.attempt ? ` at attempt ${f.attempt}` : ''}`,
      `      culprit: ${f.locations.slice(0, 3).join(', ')} (${n} of ${f.hunk_count} hunk${f.hunk_count === 1 ? '' : 's'}) · confirmed by ${f.probes} probe${f.probes === 1 ? '' : 's'}`,
      `      next: revert just ${n === 1 ? 'that hunk' : 'those hunks'} to restore green (kerb restore ${f.good_state.slice(0, 11)} --keep-except f:${f.id.slice(0, 6)} --patch); your other edits are kept`,
    ];
  }
  const lines = [`kerb: cause · couldn't isolate why ${name} broke: ${f.reason_if_undetermined}`];
  if (f.partial && f.locations.length) lines.push(`      smallest failing set found (not confirmed): ${f.locations.slice(0, 3).join(', ')}`);
  return lines;
}

/**
 * Findings not yet delivered (at most two), as context lines; marks them delivered.
 * Cheap when there is nothing new: the worker counts pending findings in the summary.
 */
export function deliverFindings(store, loadSummary, readRecs, delivered = null) {
  const summary = loadSummary();
  if (!summary.findings_pending) return [];
  const done = new Set(summary.findings_delivered || []);
  const fresh = readRecs().filter((r) => r.type === 'finding' && !done.has(r.id)).slice(-2);
  const lines = fresh.flatMap(findingLines);
  if (delivered) delivered.push(...fresh);
  store.updateSummary((s) => {
    s.findings_delivered = [...(s.findings_delivered || []), ...fresh.map((f) => f.id)].slice(-100);
    s.findings_pending = 0;
  });
  return lines;
}
