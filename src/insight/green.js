// Last green (KERB-V2 7.5): the newest kept state where a key passed, or where one test passed.
import { readState } from '../state/keep.js';
import { buildRuns } from '../store/jsonl.js';
import { keyRuns, isSuccess, endTs, keyCommand } from './history.js';
import { recentKeys } from './ledger.js';

/** A key from `--key` (exact, or the command part), else the most recently run check key. */
export function resolveKey(recs, want) {
  const keys = recentKeys(recs, 0);
  if (!want) return keys[0] || null;
  return keys.find((k) => k === want) || keys.find((k) => keyCommand(k) === want) || null;
}

/**
 * @param {string} root
 * @param {any[]} recs
 * @param {{ key?: string | null, test?: string | null }} o
 * @returns {{ key: string | null, state: any, run: any, test: string | null } | null}
 */
export function lastGreen(root, recs, o = {}) {
  if (o.test) {
    const t = o.test;
    const runs = new Map(buildRuns(recs).map((r) => [r.id, r]));
    const passes = recs.filter((r) => r.type === 'test_result' && r.status === 'pass' && r.state
      && (r.test_id === t || r.test_id.endsWith(`::${t}`)) && (!o.key || r.key === o.key));
    for (let i = passes.length - 1; i >= 0; i--) {
      const state = readState(root, passes[i].state);
      if (state) return { key: passes[i].key, state, run: runs.get(passes[i].run) || { id: passes[i].run, end_ts: passes[i].ts }, test: passes[i].test_id };
    }
    return null;
  }
  if (!o.key) return null;
  const runs = keyRuns(recs, o.key);
  for (let i = runs.length - 1; i >= 0; i--) {
    if (!isSuccess(runs[i])) continue;
    const state = readState(root, runs[i].post_hash);
    if (state) return { key: o.key, state, run: runs[i], test: null };
  }
  return null;
}

export { endTs };
