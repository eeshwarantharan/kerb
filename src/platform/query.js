// The read-only query layer (KERB-V2 11.1): one place that answers questions about the records,
// used by `kerb query`, `kerb export`, the MCP server (11.2) and plugins' ctx.query (11.3). Every
// function reads; none writes the event log, the indexes or the summary.
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { now, sha256 } from '../util/core.js';
import { Store, buildRuns } from '../store/jsonl.js';
import { loadSummary, currentSession } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { readState } from '../state/keep.js';
import { redactText } from '../run/redact.js';
import { kerRun } from './ker.js';
import { validate } from './validate.js';
import { QUERY_SCHEMAS } from './schema/index.js';
import { keyRuns, testsByRun, flakyTests, isFailure, isSuccess, keyCommand, endTs } from '../insight/history.js';
import { progress as keyProgress } from '../insight/converge.js';
import { verification as verify } from '../insight/verify.js';
import { recentKeys, renderLedger, WINDOW_MS } from '../insight/ledger.js';
import { latestFixes } from '../insight/fixes.js';
import { lastGreen as findGreen } from '../insight/green.js';

export const QUERY_NAMES = Object.keys(QUERY_SCHEMAS);
const DEFAULT_LIMIT = 50;

/** Does key `k` match what the user typed: the key itself, or its command part? */
export function keyMatches(k, want) {
  return !want || k === want || keyCommand(k) === want;
}

/** Does test id `id` match: the id itself, or its name after `::`? */
export function testMatches(id, want) {
  return !want || id === want || id.endsWith(`::${want}`);
}

/**
 * A read-only view of one repo's records.
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, recs?: any[] }} o recs: use these records instead of reading the log
 */
export function openQuery(o) {
  const { root, git } = findRoot(o.cwd);
  const store = new Store(root);
  const env = o.env || process.env;
  let cache = o.recs || null;
  let policyCache = null;
  const recs = () => cache || (cache = store.read({ maxBytes: Number.MAX_SAFE_INTEGER, repair: false }));
  const policy = () => policyCache || (policyCache = loadPolicy(root, loadConfig(), now()));
  const q = {
    root,
    git,
    records: recs,

    /** Finished runs, newest first. */
    runs(a = {}) {
      const since = a.since ? now() - a.since : 0;
      const runs = buildRuns(recs()).filter((r) => r.finished && endTs(r) >= since && keyMatches(r.key, a.key)
        && (!a.state || r.post_hash === a.state || r.pre_hash === a.state)
        && (!a.status || (a.status === 'failure' ? isFailure(r) : a.status === 'success' ? isSuccess(r) : true)))
        .sort((x, y) => endTs(y) - endTs(x)).slice(0, a.limit || DEFAULT_LIMIT);
      return { query: 'runs', runs: runs.map((r) => ({ ...kerRun(r), cmd: r.cmd || keyCommand(r.key), first_fail_line: r.first_fail_line ?? null })) };
    },

    /** One entry per test id: its latest status, with flaky ones marked. */
    tests(a = {}) {
      const since = a.since ? now() - a.since : 0;
      const flaky = flakyTests(recs());
      const by = new Map();
      for (const r of recs()) {
        if (r.type !== 'test_result' || !testMatches(r.test_id, a.test) || !keyMatches(r.key || '', a.key) || (r.ts || 0) < since) continue;
        const e = by.get(r.test_id) || { test_id: r.test_id, status: 'passing', key: r.key ?? null, last_run: r.run, last_state: r.state ?? null, last_ts: r.ts ?? null, runs: 0, failures: 0, message: null };
        e.runs++;
        if (r.status === 'fail' || r.status === 'error') { e.failures++; e.message = r.message ? String(r.message).slice(0, 200) : e.message; }
        e.status = flaky.has(r.test_id) ? 'flaky' : r.status === 'pass' ? 'passing' : r.status === 'skip' ? 'skipped' : 'failing';
        Object.assign(e, { key: r.key ?? null, last_run: r.run, last_state: r.state ?? null, last_ts: r.ts ?? null });
        by.set(r.test_id, e);
      }
      const want = a.status || null;
      const tests = [...by.values()].filter((t) => !want || t.status === want).sort((x, y) => (y.last_ts || 0) - (x.last_ts || 0)).slice(0, a.limit || 200);
      return { query: 'tests', tests };
    },

    /** Verification of the keys `kerb status` tracks (the latest session's check keys and policy verify_keys). */
    verification(a = {}) {
      const session = currentSession(loadSummary(store.dir));
      const keys = verify({ root, git, recs: recs(), session: session.id, policy: policy(), env, keys: a.keys, budgetMs: a.budgetMs });
      return { query: 'verification', keys: keys.map(({ current, ...v }) => (void current, v)) };
    },

    /** Failing counts since the last success per check key with runs in the last 24 hours. */
    progress(a = {}) {
      const keys = recentKeys(recs(), now() - WINDOW_MS).filter((k) => keyMatches(k, a.key));
      return { query: 'progress', keys: keys.map((k) => { const p = keyProgress(recs(), k); return { key: k, command: p.command, counts: p.counts, signal: p.signal, runs: p.runs.map((r) => r.id) }; }) };
    },

    /** Proven fixes (the latest version of each), newest first. */
    fixes(a = {}) {
      const fixes = latestFixes(recs()).filter((f) => (!a.fingerprint || f.fingerprint === a.fingerprint || f.family === a.fingerprint)
        && (!a.test || (f.test_ids || []).some((id) => testMatches(id, a.test))) && keyMatches(f.key || '', a.key))
        .sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, a.limit || DEFAULT_LIMIT);
      return { query: 'fixes', fixes };
    },

    /** Cause findings, newest first. */
    findings(a = {}) {
      const findings = recs().filter((r) => r.type === 'finding' && testMatches(r.test_id, a.test)).reverse().slice(0, a.limit || DEFAULT_LIMIT);
      return { query: 'findings', findings: findings.map(({ crc, ...f }) => (void crc, f)) };
    },

    /** Kept post-states of check runs, newest first. */
    states(a = {}) {
      const keys = [...new Set(buildRuns(recs()).filter((r) => r.finished && r.class === 'check' && keyMatches(r.key, a.key)).map((r) => r.key))];
      const out = [];
      const seen = new Set();
      for (const k of keys) {
        for (const r of keyRuns(recs(), k)) {
          if (!r.post_hash || (a.green && !isSuccess(r))) continue;
          const s = readState(root, r.post_hash);
          if (!s) continue;
          const id = `${r.post_hash}\0${k}\0${isSuccess(r)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({ type: 'state', id: s.id, ts: endTs(r), mode: s.mode, scope: s.scope ?? '.', snapshot_tree: s.tree || null, commit: s.commit || null, env_stamp: s.env_stamp || null, materializable: !!s.materializable, key: k, run: r.id, green: isSuccess(r) });
        }
      }
      return { query: 'states', states: out.sort((x, y) => y.ts - x.ts).slice(0, a.limit || DEFAULT_LIMIT) };
    },

    /** The attempt ledger (7.4) and its keys. */
    attempts(a = {}) {
      const nowTs = now();
      let keys = recentKeys(recs(), nowTs - WINDOW_MS).filter((k) => keyMatches(k, a.key)).slice(0, 3);
      const v = keys.length ? verify({ root, git, recs: recs(), session: null, policy: policy(), env, keys, anySession: true }) : [];
      const text = keys.length ? renderLedger({ root, store, recs: a.key ? recs().filter((r) => !r.key || keys.includes(r.key)) : recs(), nowTs, branch: null, verification: Object.fromEntries(v.map((x) => [x.key, x])) }) : '';
      keys = keys.map((k) => { const p = keyProgress(recs(), k); return { key: k, command: p.command, attempts: p.runs.length, counts: p.counts, signal: p.signal, runs: p.runs.map((r) => r.id) }; });
      return { query: 'attempts', text, keys };
    },

    /** One test's results, newest first. */
    testHistory(testId, a = {}) {
      const rows = recs().filter((r) => r.type === 'test_result' && testMatches(r.test_id, testId)).reverse().slice(0, a.limit || 20);
      return { query: 'test_history', test_id: rows[0] ? rows[0].test_id : testId, flaky: rows.length ? flakyTests(recs()).has(rows[0].test_id) : false,
        results: rows.map((r) => ({ run: r.run, ts: r.ts ?? null, status: r.status, state: r.state ?? null, key: r.key ?? null, location: r.location ?? null, message: r.message ?? null })) };
    },

    /** The newest kept state where a key (or one test) passed. */
    lastGreen(a = {}) {
      const keys = recentKeys(recs(), 0);
      const key = a.key ? keys.find((k) => keyMatches(k, a.key)) || null : a.test ? null : keys[0] || null;
      const g = (key || a.test) ? findGreen(root, recs(), { key, test: a.test || null }) : null;
      return { query: 'last_green', green: g ? { key: g.key, test: g.test, state: g.state.id, run: g.run.id, ts: endTs(g.run), materializable: !!g.state.materializable } : null };
    },

    /** Boundaries in effect: kind, pattern, where it comes from. */
    boundaries() {
      const p = policy();
      return { query: 'boundaries', boundaries: p.boundaries.map((b) => ({ kind: b.kind, pattern: b.pattern, source: b.source, layer: b.layer, alternative: b.alternative || null, why: b.why || null })),
        suspected: (p.suspected || []).map((e) => ({ kind: 'host', pattern: e.pattern, hits: e.hits })) };
    },

    /** A refusal (by id, or the refusal of a run) or a run with its failing tests. */
    explain(id) {
      const all = recs();
      const ref = all.filter((r) => r.type === 'refusal' || r.type === 'would_refuse').reverse().find((r) => r.id === id || r.id.startsWith(id) || r.matched_run === id) || null;
      if (ref) { const { crc, ...refusal } = ref; void crc; return { query: 'explain', refusal, run: null, failing: [] }; }
      const run = buildRuns(all).find((r) => r.finished && (r.id === id || r.id.startsWith(id)));
      if (!run) return { query: 'explain', refusal: null, run: null, failing: [] };
      const failing = (testsByRun(all).get(run.id) || []).filter((t) => t.status === 'fail' || t.status === 'error').map((t) => ({ test_id: t.test_id, status: t.status, location: t.location ?? null, message: t.message ?? null }));
      return { query: 'explain', refusal: null, run: { ...kerRun(run), cmd: run.cmd || keyCommand(run.key), first_fail_line: run.first_fail_line ?? null, log: run.log ? path.relative(root, run.log) || run.log : null }, failing };
    },
  };
  return Object.freeze(q);
}

/** Problems with a query result against its published schema ([] when valid or not a published query). */
export function validateQuery(result) {
  const s = QUERY_SCHEMAS[result && result.query];
  return s ? validate(s, result) : [];
}

// ---- Export (11.4) ----

/** Fields whose string values are identifiers or codes, kept by --no-text. */
const ID_FIELDS = new Set(['type', 'id', 'session', 'run', 'matched_run', 'source_run', 'from_run', 'to_run', 'state', 'pre_state', 'post_state', 'from_state', 'to_state',
  'good_state', 'bad_state', 'fingerprint', 'family', 'commit', 'class', 'status', 'failure_kind', 'class_result', 'confidence', 'reason', 'mode', 'framework',
  'agent', 'tier', 'kind', 'level', 'result', 'env_stamp', 'snapshot_tree', 'signal', 'loop_skipped', 'env_subtype']);
/** Fields whose values name things in the repo: hashed by --no-text. */
const HASH_FIELDS = new Set(['key', 'test_id', 'test_ids', 'pattern', 'host', 'scope', 'culprit_hunks', 'text', 'source']);
const hashed = (v) => `h:${sha256(String(v)).slice(0, 16)}`;

function noText(v, field) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (HASH_FIELDS.has(field)) return hashed(v);
    // A fix's fingerprint can be its failing test ids (t:…): hash anything that isn't already a hash.
    if (field === 'fingerprint' || field === 'family') return /^[0-9a-f]+$/.test(v) ? v : hashed(v);
    return ID_FIELDS.has(field) ? v : undefined;
  }
  if (Array.isArray(v)) {
    if (HASH_FIELDS.has(field)) return v.map((x) => hashed(x));
    return undefined; // arrays of paths, hunks or lines
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = noText(x, k); if (y !== undefined) out[k] = y; }
    return out;
  }
  return undefined;
}

function redacted(v) {
  if (typeof v === 'string') return redactText(v);
  if (Array.isArray(v)) return v.map(redacted);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redacted(x)]));
  return v;
}

/** Types written by `kerb export`: the published KER types, with runs derived from the log's start/end/wait. */
const EXPORT_SKIP = new Set(['start', 'end', 'wait']);
const EXPORT_TYPES = new Set(['session', 'state', 'test_result', 'refusal', 'would_refuse', 'cached_answer', 'fix', 'finding', 'learn', 'note', 'ack', 'reset']);

/**
 * KER records for export: derived `run` records instead of start/end/wait, the latest version of
 * each fix, no crc, text redacted again (or removed with noText).
 * @param {any[]} recs
 * @param {{ since?: number, noText?: boolean }} o since: milliseconds back from now
 */
export function exportRecords(recs, o = {}) {
  const sinceTs = o.since ? now() - o.since : 0;
  const out = [];
  const runs = new Map(buildRuns(recs).filter((r) => r.finished).map((r) => [r.id, r]));
  const fixes = new Map(latestFixes(recs).map((f) => [f.id, f]));
  const doneFix = new Set();
  for (const r of recs) {
    if (!r || typeof r.type !== 'string' || EXPORT_SKIP.has(r.type)) {
      // A run is exported where it finished.
      if (r && (r.type === 'end' || r.type === 'wait') && runs.has(r.id)) {
        const run = runs.get(r.id);
        if (endTs(run) >= sinceTs) out.push({ ...kerRun(run), cmd: run.cmd || keyCommand(run.key), first_fail_line: run.first_fail_line ?? null });
      }
      continue;
    }
    if (!EXPORT_TYPES.has(r.type)) continue;
    if ((r.ts || 0) < sinceTs) continue;
    let rec = r;
    if (r.type === 'fix') {
      if (doneFix.has(r.id)) continue;
      doneFix.add(r.id);
      rec = fixes.get(r.id) || r;
    }
    const { crc, ...body } = rec;
    void crc;
    out.push(body);
  }
  return out.map((x) => (o.noText ? noText(x, null) : redacted(x)));
}
