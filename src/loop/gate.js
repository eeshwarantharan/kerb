// Loopbreaker gate for check-class commands: compute state, evaluate the rules, and hand the
// runner a post-hash callback.
import { checkSegment } from '../parse/classify-cmd.js';
import { hashWorkspace, scopeAndStamp, writeSnapshot } from './workspace.js';
import { evaluateRules, keyHistory, isFailure } from './rules.js';
import { loadRuns } from '../engine.js';
import { now } from '../util/core.js';

/**
 * @param {any} prep engine prep
 * @param {{ force?: boolean, hashBudgetMs?: number, dryRun?: boolean, runs?: any[], lazy?: boolean }} o
 *   lazy: hash only when this key has a failure to compare against (hooks; the post hook
 *   always records the post-hash, so later calls can still be judged).
 * @returns {{ refusal: any | null, matched: any | null, loop: any }}
 */
export function loopGate(prep, o = {}) {
  const budget = o.hashBudgetMs || 2000;
  const seg = checkSegment(prep.parsed, prep.checkCommands);
  const segCwd = seg ? seg.cwd : prep.ctx.cwd;
  const { scope, envStamp } = scopeAndStamp(prep, segCwd);
  const hctx = { root: prep.root, git: prep.git, policy: prep.policy, env: prep.ctx.env };
  let recs = null;
  if (o.lazy && !o.force) {
    recs = o.runs || loadRuns(prep.store).recs;
    const { postAck } = keyHistory(recs, prep.key);
    if (!postAck.some(isFailure)) {
      return { refusal: null, matched: null, loop: { scope: scope.pkgRel, envStamp, preHash: null, skipped: null, lazy: true, postHash: null } };
    }
  }
  const pre = hashWorkspace(hctx, scope, budget);
  const loop = {
    scope: scope.pkgRel,
    envStamp,
    preHash: pre.hash,
    skipped: pre.skipped,
    hashMs: pre.ms,
    /** Post-hash after the run; writes the run's snapshot. */
    postHash(runId) {
      const post = hashWorkspace(hctx, scope, budget);
      if (post.snapshot) writeSnapshot(prep.store, runId, post.snapshot);
      return { hash: post.hash, skipped: post.skipped };
    },
  };
  if (o.force || pre.skipped) return { refusal: null, matched: null, loop };
  const runs = recs || o.runs || loadRuns(prep.store).recs;
  const verdict = evaluateRules({
    recs: runs,
    key: prep.key,
    hash: pre.hash,
    envStamp,
    nowTs: now(),
    policy: prep.policy,
    root: prep.root,
    store: prep.store,
    command: prep.command,
  });
  return { refusal: verdict ? verdict.refusal : null, matched: verdict ? verdict.matched : null, loop };
}
