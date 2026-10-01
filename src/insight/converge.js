// Convergence (KERB-V2 7.3) and the oscillation cycle (6.1), per key, over runs since the last
// success. Signals: green, oscillating, stalled, diverging, converging (first match wins).
import { keyRuns, sinceSuccess, failingCount, isSuccess, isFailure, keyCommand, failPrinter } from './history.js';

const ordinary = (r) => isFailure(r) && (r.failure_kind || 'ordinary') === 'ordinary';

/**
 * A cycle of 2–4 states in the last (at most 6) runs, all ordinary failures (6.1).
 * @param {any[]} window runs since the last success (or ack), oldest first
 * @returns {{ length: number, runs: any[], next: string, states: string[] } | null}
 *   next: the state that would continue the cycle
 */
export function findCycle(window) {
  const w = window.slice(-6);
  for (let L = 2; L <= 4; L++) {
    if (w.length < L + 2) continue;
    const tail = w.slice(-(L + Math.min(L, w.length - L)));
    const m = tail.length;
    let ok = true;
    for (let i = L; i < m; i++) if (!tail[i].post_hash || tail[i].post_hash !== tail[i - L].post_hash) { ok = false; break; }
    if (!ok) continue;
    const states = tail.slice(0, L).map((r) => r.post_hash);
    if (new Set(states).size !== L) continue;
    if (!tail.every(ordinary)) continue;
    return { length: L, runs: tail, next: tail[m - L].post_hash, states };
  }
  return null;
}

/**
 * @param {any[]} recs
 * @param {string} key
 * @returns {{ key: string, command: string, counts: (number|null)[], signal: string | null, runs: any[] }}
 */
export function progress(recs, key) {
  const runs = keyRuns(recs, key);
  const win = sinceSuccess(runs);
  const counts = win.map(failingCount);
  let signal = null;
  const last = win[win.length - 1];
  if (last && isSuccess(last)) signal = 'green';
  else if (findCycle(win.filter((r) => !isSuccess(r)))) signal = 'oscillating';
  else {
    const last3 = win.slice(-3);
    const prints = last3.map(failPrinter(recs));
    if (last3.length === 3 && prints[0] && prints.every((p) => p === prints[0]) && new Set(last3.map((r) => r.post_hash)).size >= 2) signal = 'stalled';
    else {
      const c = counts.filter((x) => x != null);
      const n = c.length;
      if (n >= 3 && c[n - 1] > c[n - 2] && c[n - 2] > c[n - 3]) signal = 'diverging';
      else if (n >= 3) {
        const recent = c.slice(-4);
        let fell = 0;
        for (let i = 1; i < recent.length; i++) if (recent[i] < recent[i - 1]) fell++;
        if (fell >= 2) signal = 'converging';
      }
    }
  }
  return { key, command: keyCommand(key), counts, signal, runs: win };
}

/** "5 → 3 → 3 → 3" (✗ for a failure with no count). */
export function series(counts, sep = ' → ') {
  return counts.map((c) => (c == null ? '✗' : String(c))).join(sep);
}
