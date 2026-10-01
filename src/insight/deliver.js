// Delivery (KERB-V2 9): what reaches the agent, when. One block per moment, each within its size
// limit, each starting with `kerb:` or `kerb ledger`, built only from records.
//   after a command   delta, environment fix, fix hints, notes        ≤ 10 lines
//   session start     briefing, ledger, verification                  ≤ 400 tokens (fresh)
//                     ledger, verification                            ≤ 300 tokens (compaction, resume)
//   stop              recap, verification warning or gate             ≤ 8 lines
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from '../util/fsx.js';
import { branchOf } from '../util/repo.js';
import { computeDelta } from './delta.js';
import { progress, series } from './converge.js';
import { renderLedger, recentKeys, WINDOW_MS } from './ledger.js';
import { verification, verificationLine } from './verify.js';

export const AFTER_MAX_LINES = 10;
export const START_FRESH_BYTES = 400 * 4;
export const START_AFTER_BYTES = 300 * 4;
export const STOP_MAX_LINES = 8;
const READ_BYTES = 4 * 1024 * 1024;

const capLines = (lines, n) => (lines.length > n ? [...lines.slice(0, n - 1), `kerb: note · ${lines.length - n + 1} more lines in kerb status`] : lines);

function capBytes(text, max) {
  if (Buffer.byteLength(text) <= max) return text;
  const lines = text.split('\n');
  while (lines.length > 1 && Buffer.byteLength(lines.join('\n')) > max) lines.pop();
  return lines.join('\n');
}

/**
 * After a command: the one block of context (delta first, then the environment fix, hints and
 * notes). Also stores the key's verification and series in the summary for the status line.
 * @param {any} prep engine prep (the run's)
 * @param {{ runId: string, cls: string, notes?: string[], hints?: string[], envFix?: string[], insights?: boolean }} o
 * @returns {{ lines: string[], delta: string[] }}
 */
export function afterCommand(prep, o) {
  let delta = [];
  if (o.cls === 'check') {
    try {
      const recs = prep.store.read({ maxBytes: READ_BYTES });
      if (o.insights !== false) {
        const d = computeDelta(recs, o.runId);
        if (d) delta = d.lines;
      }
      const end = recs.find((r) => r.type === 'end' && r.id === o.runId);
      if (end && end.exit != null) {
        const p = progress(recs, end.key);
        prep.store.updateSummary((s) => {
          s.verification = { key: end.key, command: p.command, status: end.exit === 0 && end.class_result === 'ok' ? 'green' : 'red', files: [], series: p.counts, signal: p.signal, ts: end.ts, session: end.session || null };
        });
      }
    } catch { /* insights never break a run */ }
  }
  const lines = [...delta, ...(o.envFix || []), ...(o.hints || []).map((h) => `kerb: hint · ${h}`), ...(o.notes || []).map((n) => `kerb: note · ${n}`)];
  return { lines: capLines(lines, AFTER_MAX_LINES), delta };
}

/**
 * Session start (fresh, or after compaction / resume).
 * @param {{ root: string, git: boolean, store: any, policy: any, env: NodeJS.ProcessEnv, nowTs: number,
 *   after: boolean, session: string | null, briefing: string[], insights?: boolean }} o
 */
export function sessionStartText(o) {
  const parts = [];
  if (!o.after && o.briefing.length) parts.push(`kerb: active in this repo · known boundaries:\n${o.briefing.join('\n')}`);
  if (o.insights !== false && fs.existsSync(o.store.file)) {
    const recs = o.store.read({ maxBytes: READ_BYTES });
    const keys = recentKeys(recs, o.nowTs - WINDOW_MS).slice(0, 3);
    if (keys.length) {
      const v = verification({ root: o.root, git: o.git, recs, session: o.session, policy: o.policy, env: o.env, keys, anySession: true, budgetMs: 500 });
      const byKey = Object.fromEntries(v.map((x) => [x.key, x]));
      const ledger = renderLedger({ root: o.root, store: o.store, recs, nowTs: o.nowTs, branch: branchOf(o.root), verification: byKey });
      if (ledger) parts.push(ledger);
      if (o.after) for (const x of v) { const l = verificationLine(x); if (l) parts.push(`kerb: verification · ${l}`); }
    }
  }
  return capBytes(parts.join('\n'), o.after ? START_AFTER_BYTES : START_FRESH_BYTES);
}

/**
 * Stop: the verification warning (once per state) and, with policy stop_gate "block", a block
 * once per session and verification state, then yield.
 * @returns {{ lines: string[], block: string | null }}
 */
export function stopVerification(o) {
  const gate = o.policy.stop_gate || 'warn';
  if (gate === 'off' || !fs.existsSync(o.store.file)) return { lines: [], block: null };
  const recs = o.store.read({ maxBytes: READ_BYTES });
  const v = verification({ root: o.root, git: o.git, recs, session: o.session, policy: o.policy, env: o.env, budgetMs: 700 });
  const stale = v.filter((x) => x.status === 'stale' || x.status === 'red');
  const top = v.find((x) => x.status !== 'never') || null;
  if (top) {
    o.store.updateSummary((s) => {
      const p = progress(recs, top.key);
      s.verification = { key: top.key, command: top.command, status: top.status, files: top.files, series: p.counts, signal: p.signal, ts: Date.now(), session: o.session };
    });
  }
  if (!stale.length) return { lines: [], block: null };
  const lines = stale.map((x) => `kerb: verification · ${verificationLine(x)}`).filter(Boolean).slice(0, 3);
  const signature = stale.map((x) => `${x.key}:${x.status}:${x.current}`).join('|');
  const summary = o.loadSummary();
  const shown = (summary.verification_shown || {})[o.session || ''] === signature;
  let block = null;
  if (gate === 'block' && stale.some((x) => x.status === 'stale') && !shown) {
    block = `${lines.join('\n')}\nkerb: verification · run the tests again before you finish, or say plainly that they are not verified on these files`;
  }
  o.store.updateSummary((s) => { s.verification_shown = { ...(s.verification_shown || {}), [o.session || '']: signature }; });
  return { lines: shown ? [] : lines, block };
}

/** The status-line segment: "tests: stale (pricing.ts) · failing 5→2→0". */
export function statusSegment(v) {
  if (!v || !v.status) return null;
  const files = v.files && v.files.length ? ` (${v.files.slice(0, 2).map((f) => path.basename(f)).join(', ')})` : '';
  const s = v.series && v.series.length > 1 && v.series.some((c) => c != null) ? ` · failing ${series(v.series, '→')}` : '';
  return `tests: ${v.status}${files}${s}`;
}

/** Best-effort agents: the ledger in .kerb/ledger.md, which the instructions block points to. */
export function writeLedgerFile(root, store, nowTs) {
  try {
    const recs = store.read({ maxBytes: READ_BYTES });
    const text = renderLedger({ root, store, recs, nowTs, branch: branchOf(root) });
    atomicWrite(path.join(store.dir, 'ledger.md'), text ? `${text}\n` : 'kerb ledger · no recent attempts\n');
  } catch { /* best effort */ }
}
