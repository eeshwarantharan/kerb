// Loopbreaker rules (4.7.6): identical_retry, deja_vu, breaker_open; cooldowns; ack/reset windows.
import { EXIT } from '../util/core.js';
import { buildRuns } from '../store/jsonl.js';
import { diffSnapshots, readSnapshot } from './workspace.js';

const SETUP_CLASSES = new Set(['check', 'other', 'background']);

/** A finished run that counts as a failure (4.7.5). */
export function isFailure(r) {
  return r.finished && r.exit != null && r.exit !== 0 && r.class === 'check'
    && r.class_result !== 'policy_denial' && r.class_result !== 'aborted';
}

export function isSuccess(r) {
  return r.finished && r.exit === 0 && (r.class_result === 'ok' || r.class_result == null);
}

const endTs = (r) => r.end_ts ?? r.ts;
const startTs = (r) => (r.is_wait ? r.start_ts ?? r.ts : r.ts);

/**
 * The history of one key relevant to the rules.
 * @param {any[]} recs raw records
 * @param {string} key
 */
export function keyHistory(recs, key) {
  const runs = buildRuns(recs).filter((r) => r.finished);
  const keyRuns = runs.filter((r) => r.key === key).sort((a, b) => endTs(a) - endTs(b));
  let windowStart = -Infinity;
  for (const r of recs) if (r.type === 'reset' && (!r.key || r.key === key)) windowStart = Math.max(windowStart, r.ts);
  for (const r of keyRuns) if (isSuccess(r)) windowStart = Math.max(windowStart, endTs(r));
  const acks = recs.filter((r) => r.type === 'ack' && r.key === key && r.ts > windowStart);
  const ack = acks.length ? acks[acks.length - 1] : null;
  const window = keyRuns.filter((r) => endTs(r) > windowStart);
  const postAck = ack ? window.filter((r) => endTs(r) > ack.ts) : window;
  return { runs, keyRuns, window, postAck, ack };
}

/** Did any other check/other/background command finish in (from, to]? */
function setupBetween(runs, key, from, to = Infinity) {
  return runs.some((x) => x.key !== key && SETUP_CLASSES.has(x.class) && endTs(x) > from && endTs(x) <= to);
}

function kindLabel(k) {
  return k === 'dependency' ? 'dependency unavailable' : k || 'ordinary';
}

function evidenceFor(r, extra = '') {
  const line = r.first_fail_line ? ` · ${r.first_fail_line}` : '';
  return `matches run ${r.id} (${kindLabel(r.failure_kind)}${extra})${line}`;
}

function shortCmd(c) {
  const t = c.trim().replace(/\s+/g, ' ');
  return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/**
 * Evaluate the rules for a check-class command about to run.
 * @param {{ recs: any[], key: string, hash: string, envStamp: string, nowTs: number, policy: any,
 *   root?: string, store?: any, command: string }} input
 * @returns {{ refusal: any, matched: any } | null}
 */
export function evaluateRules(input) {
  const { recs, key, hash, envStamp, nowTs, policy, command } = input;
  if (!hash) return null;
  const { runs, window, postAck, ack } = keyHistory(recs, key);
  // After `kerb ack`, exactly one run is allowed regardless of the rules.
  if (ack && postAck.length === 0) return null;
  if (!postAck.length) return null;
  const latest = postAck[postAck.length - 1];
  const cooldownMs = policy.retry_cooldown_ms ?? 60_000;
  const K = policy.breaker_threshold ?? 3;

  // 1. identical_retry
  if (isFailure(latest) && latest.post_hash && latest.post_hash === hash && latest.env_stamp === envStamp
    && !setupBetween(runs, key, endTs(latest))) {
    const kind = latest.failure_kind || 'ordinary';
    if (kind === 'ordinary') {
      return refuse('identical_retry', 'nothing relevant changed since this failed', evidenceFor(latest),
        'change something first, or run `kerb diff` to compare attempts', latest, { kind });
    }
    if (kind === 'transient') {
      const prev = postAck.length >= 2 ? postAck[postAck.length - 2] : null;
      const wasRetry = prev && isFailure(prev) && prev.failure_kind === 'transient' && prev.post_hash
        && latest.pre_hash === prev.post_hash && latest.env_stamp === prev.env_stamp
        && !setupBetween(runs, key, endTs(prev), startTs(latest));
      if (wasRetry) {
        return refuse('identical_retry', 'this failed twice on a flaky dependency', evidenceFor(latest, `, after retry of ${prev.id}`),
          'this failed twice on a flaky dependency; wait or check it before retrying', latest, { kind });
      }
    }
    if (kind === 'dependency') {
      const left = cooldownMs - (nowTs - endTs(latest));
      if (left > 0) {
        const secs = Math.ceil(left / 1000);
        return refuse('identical_retry', 'a service this needs was unavailable moments ago', evidenceFor(latest),
          `a service this needs looks unavailable; start it, or poll with \`kerb wait-for -- ${shortCmd(command)}\` (retry allowed in ${secs} s)`,
          latest, { kind, retry_in_s: secs });
      }
    }
  }

  // 2. deja_vu
  for (let i = postAck.length - 2; i >= 0; i--) {
    const f = postAck[i];
    if (isFailure(f) && (f.failure_kind || 'ordinary') === 'ordinary' && f.post_hash === hash && f.env_stamp === envStamp
      && latest.post_hash !== f.post_hash) {
      const ago = postAck.length - i;
      return refuse('deja_vu', 'your files are back in a state that already failed', `matches run ${f.id}, ${ago} attempts ago${f.first_fail_line ? ` · ${f.first_fail_line}` : ''}`,
        'your files match a state that already failed; try a different fix', f, { attempts_ago: ago });
    }
  }

  // 3. breaker_open. After an ack, a same-fingerprint failure reopens it immediately.
  let seq = postAck;
  if (ack && postAck.length && isFailure(postAck[0]) && postAck[0].fingerprint === ack.fingerprint) seq = window;
  const counted = seq.filter((r) => !(isFailure(r) && (r.failure_kind === 'transient' || r.failure_kind === 'dependency')));
  const lastK = counted.slice(-K);
  if (lastK.length === K && lastK.every((r) => isFailure(r) && (r.failure_kind || 'ordinary') === 'ordinary' && r.fingerprint === lastK[0].fingerprint)
    && new Set(lastK.map((r) => r.post_hash)).size >= 2) {
    const files = changedFiles(input, lastK);
    const evidence = files.length ? `changed across those runs: ${files.join(', ')}` : `runs ${lastK.map((r) => r.id).join(', ')}`;
    return refuse('breaker_open', `the same failure happened ${K} times in a row despite edits`, evidence,
      `same failure ${K} times despite edits; step back and rethink, or ask the user to run \`kerb ack\``,
      lastK[lastK.length - 1], { files, runs: lastK.map((r) => r.id), fingerprint: lastK[0].fingerprint });
  }
  return null;
}

/** Union of files changed between consecutive runs (max 10). */
function changedFiles(input, runs) {
  if (!input.store || !input.root) return [];
  const out = new Set();
  try {
    for (let i = 1; i < runs.length && out.size < 10; i++) {
      const d = diffSnapshots(input.root, readSnapshot(input.store, runs[i - 1].id), readSnapshot(input.store, runs[i].id));
      if (d) for (const f of d) out.add(f);
    }
  } catch { /* evidence is best effort */ }
  return [...out].slice(0, 10);
}

function refuse(reason, summary, evidence, next, matched, details) {
  return {
    refusal: { reason, summary, evidence, next, exit: EXIT.LOOP, run: matched.id, details: { ...details, first_fail_line: matched.first_fail_line || null } },
    matched,
  };
}
