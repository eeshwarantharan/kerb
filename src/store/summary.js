// .kerb/summary.json (4.11.1): session and 7-day totals, rewritten atomically after every record.
// The status line, recap and card read only this file.
import path from 'node:path';
import { atomicWrite, readJson } from '../util/fsx.js';

const LOOP = new Set(['identical_retry', 'deja_vu', 'breaker_open']);

export function emptyCounters() {
  return {
    runs: 0,
    refusals: 0,
    by_reason: {},
    reruns_avoided: 0,
    avoided_ms: 0,
    avoided_bytes: 0,
    waits: 0,
    polls_folded: 0,
    raw_bytes: 0,
    shown_bytes: 0,
    trimmed_bytes: 0,
    hangs_killed: 0,
    walls_new: 0,
    walls_suspected: 0,
    loop_skipped: 0,
    loop_checked: 0,
  };
}

export function emptySummary() {
  return {
    version: 1,
    updated: 0,
    current_session: null,
    sessions: {},
    days: {},
    walls_known: 0,
    errors: 0,
    org_cache_expired: false,
    hooks: {},
    recap_shown: {},
  };
}

export function loadSummary(dir) {
  const s = readJson(path.join(dir, 'summary.json'), null);
  if (!s || s.version !== 1) return emptySummary();
  return { ...emptySummary(), ...s };
}

export function writeSummary(dir, summary) {
  prune(summary);
  atomicWrite(path.join(dir, 'summary.json'), JSON.stringify(summary));
}

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Fold records into the summary counters.
 * @param {any} summary
 * @param {any[]} recs
 * @param {number} nowTs
 */
export function applyRecords(summary, recs, nowTs) {
  summary.updated = nowTs;
  for (const r of recs) {
    const sessionId = r.session || summary.current_session || 'default';
    let session = summary.sessions[sessionId];
    if (!session) {
      session = { started: r.ts || nowTs, last: r.ts || nowTs, agent: r.agent || null, tier: r.tier || null, counters: emptyCounters() };
      summary.sessions[sessionId] = session;
    }
    session.last = Math.max(session.last || 0, r.ts || nowTs);
    if (r.agent && !session.agent) session.agent = r.agent;
    if (r.tier) session.tier = r.tier;
    if (r.session) summary.current_session = r.session;
    const day = dayKey(r.ts || nowTs);
    summary.days[day] = summary.days[day] || emptyCounters();
    for (const c of [session.counters, summary.days[day]]) bump(c, r);
  }
}

function bump(c, r) {
  switch (r.type) {
    case 'end':
      c.runs++;
      c.raw_bytes += r.raw_bytes || 0;
      c.shown_bytes += r.shown_bytes || 0;
      c.trimmed_bytes += Math.max(0, (r.raw_bytes || 0) - (r.shown_bytes || 0));
      if (r.class_result === 'timeout' || r.class_result === 'idle') c.hangs_killed++;
      if (r.loop_skipped) c.loop_skipped++;
      if (r.loop_checked) c.loop_checked++;
      break;
    case 'refusal':
      c.refusals++;
      c.by_reason[r.reason] = (c.by_reason[r.reason] || 0) + 1;
      if (r.matched_run && LOOP.has(r.reason)) {
        c.reruns_avoided++;
        c.avoided_ms += r.avoided_duration_ms || 0;
        c.avoided_bytes += r.avoided_output_bytes || 0;
      }
      break;
    case 'wait':
      c.runs++;
      c.waits++;
      c.polls_folded += Math.max(0, (r.attempts || 1) - 1);
      c.raw_bytes += r.raw_bytes || 0;
      c.shown_bytes += r.shown_bytes || 0;
      c.trimmed_bytes += Math.max(0, (r.raw_bytes || 0) - (r.shown_bytes || 0));
      break;
    case 'learn':
      if (r.status === 'confirmed') c.walls_new++;
      else c.walls_suspected++;
      break;
    default:
      break;
  }
}

/** Sum the day buckets of the last `days` days (including today). */
export function rangeTotals(summary, nowTs, days = 7) {
  const total = emptyCounters();
  const from = dayKey(nowTs - (days - 1) * 86_400_000);
  for (const [d, c] of Object.entries(summary.days || {})) {
    if (d >= from) addCounters(total, c);
  }
  return total;
}

export function addCounters(into, c) {
  for (const [k, v] of Object.entries(c)) {
    if (k === 'by_reason') {
      for (const [r, n] of Object.entries(v)) into.by_reason[r] = (into.by_reason[r] || 0) + n;
    } else if (typeof v === 'number') into[k] = (into[k] || 0) + v;
  }
  return into;
}

/** The counters of the current session (or empty). */
export function currentSession(summary) {
  const id = summary.current_session;
  const s = id ? summary.sessions[id] : null;
  return s ? { id, ...s } : { id: null, started: null, last: null, agent: null, tier: null, counters: emptyCounters() };
}

/** Save counts are what the recap reports; a session with none prints nothing. */
export function saveCount(c) {
  return c.refusals + c.polls_folded + (c.trimmed_bytes > 0 ? 1 : 0) + c.hangs_killed + c.walls_new;
}

function prune(summary) {
  const sessions = Object.entries(summary.sessions);
  if (sessions.length > 30) {
    sessions.sort((a, b) => (a[1].last || 0) - (b[1].last || 0));
    for (const [id] of sessions.slice(0, sessions.length - 30)) {
      if (id !== summary.current_session) delete summary.sessions[id];
    }
  }
  const days = Object.keys(summary.days).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 40))) delete summary.days[d];
}
