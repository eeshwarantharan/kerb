// Proven fixes (KERB-V2 7.6) and sharing them through git notes (7.7).
// A fix is recorded when a key goes from an ordinary failure to a success. Its fingerprint is
// the failure's (the failing tests, flaky ones left out, else the output fingerprint); its family
// fingerprint is coarser (the first failing line per test, with paths, numbers and quoted names
// removed) and is used only for "similar failure" hints. Fix records hold ids, states, file
// names and redacted first lines, never output.
import { newId, now } from '../util/core.js';
import { sha } from '../loop/hashfile.js';
import { redactText } from '../run/redact.js';
import { git } from '../state/snapshot.js';
import { readState } from '../state/keep.js';
import { scopeSpecs } from '../state/hunks.js';
import { VERSION } from '../version.js';
import { keyRuns, testsByRun, failPrinter, isSuccess, isFailure } from './history.js';

export const NOTES_REF = 'refs/notes/kerb';
const FAILING = new Set(['fail', 'error']);

/** A failure message reduced to its shape: no paths, numbers or quoted names. */
export function familyLine(s) {
  return String(s || '')
    .replace(/(['"`]).*?\1/g, '<q>')
    .replace(/(?:[\w.-]*\/)+[\w.-]+(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<n>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The family fingerprint of a failing run. */
export function familyPrint(run, tests) {
  const failing = (tests || []).filter((t) => FAILING.has(t.status));
  const lines = failing.length ? failing.map((t) => familyLine(t.message || t.test_id.split('::').pop())) : [familyLine(run.first_fail_line)];
  return sha(...[...new Set(lines)].sort()).slice(0, 16);
}

/** The newest version of every fix (minimisation and commits append newer versions). */
export function latestFixes(recs) {
  const m = new Map();
  for (const r of recs) if (r.type === 'fix') m.set(r.id, { ...(m.get(r.id) || {}), ...r });
  return [...m.values()];
}

export function latestFix(recs, id) {
  return latestFixes(recs).find((f) => f.id === id || f.id.startsWith(id)) || null;
}

/** Files changed between two trees within a scope, with line counts. */
function diffStats(root, from, to) {
  const r = git(root, ['diff', '--numstat', '--no-renames', from.tree, to.tree, ...scopeSpecs(to)], { encoding: 'utf8' });
  if (r.status !== 0) return { files: [], insertions: 0, deletions: 0 };
  const files = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of r.stdout.split('\n').filter(Boolean)) {
    const [a, d, f] = line.split('\t');
    files.push(f);
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  return { files, insertions, deletions };
}

/**
 * A fix record when this run turned the key's last ordinary failure green, else null.
 * @param {string} root
 * @param {any[]} recs including the run
 * @param {string} runId
 */
export function fixFor(root, recs, runId) {
  const end = recs.find((r) => r.type === 'end' && r.id === runId);
  if (!end || end.exit !== 0) return null;
  const runs = keyRuns(recs, end.key);
  const i = runs.findIndex((r) => r.id === runId);
  if (i < 1) return null;
  const cur = runs[i];
  const prev = runs[i - 1];
  if (!isSuccess(cur) || !isFailure(prev) || (prev.failure_kind || 'ordinary') !== 'ordinary') return null;
  if (!prev.post_hash || !cur.post_hash || prev.post_hash === cur.post_hash) return null;
  const from = readState(root, prev.post_hash);
  const to = readState(root, cur.post_hash);
  if (!from || !to || from.mode !== 'git' || to.mode !== 'git') return null;
  const byRun = testsByRun(recs);
  const before = (byRun.get(prev.id) || []).filter((t) => FAILING.has(t.status)).map((t) => t.test_id);
  const after = new Map((byRun.get(cur.id) || []).map((t) => [t.test_id, t.status]));
  // Tests that went from failing to passing (diagnostics: that no longer appear).
  const fixed = before.filter((id) => !after.has(id) || after.get(id) === 'pass');
  const stats = diffStats(root, from, to);
  return {
    type: 'fix', id: newId(), ts: now(), key: end.key, fingerprint: failPrinter(recs)(prev) || prev.fingerprint || 'unknown',
    family: familyPrint(prev, byRun.get(prev.id)), test_ids: fixed, from_state: from.id, to_state: to.id, from_run: prev.id, to_run: cur.id,
    hunks: null, files: stats.files.slice(0, 20), stats: { files: stats.files.length, insertions: stats.insertions, deletions: stats.deletions },
    commit: null, confidence: 'full diff', first_fail_line: prev.first_fail_line ? redactText(prev.first_fail_line).slice(0, 200) : null,
  };
}

const short = (id) => id.slice(0, 6);
const day = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The fix that matches a failing run (7.6): an exact fingerprint match first, else a family match.
 * Fixes none of whose tests appear in this run's results any more are left out.
 * @returns {{ fix: any, exact: boolean } | null}
 */
export function matchingFix(recs, runId) {
  const end = recs.find((r) => r.type === 'end' && r.id === runId);
  if (!end || end.exit === 0) return null;
  const run = keyRuns(recs, end.key).find((r) => r.id === runId);
  if (!run || !isFailure(run)) return null;
  const tests = testsByRun(recs).get(runId) || [];
  const present = new Set(tests.map((t) => t.test_id));
  const print = failPrinter(recs)(run) || run.fingerprint;
  const family = familyPrint(run, tests);
  const fixes = latestFixes(recs).filter((f) => f.to_run !== runId && (!f.test_ids || !f.test_ids.length || !present.size || f.test_ids.some((id) => present.has(id))));
  const exact = [...fixes].reverse().find((f) => f.fingerprint === print);
  if (exact) return { fix: exact, exact: true };
  const fam = [...fixes].reverse().find((f) => f.family === family);
  return fam ? { fix: fam, exact: false } : null;
}

/**
 * The one hint for a failing run (7.6): an exact fingerprint match, else a family match.
 * No hint when none of a fix's tests exist in this run's results any more.
 * @returns {string | null}
 */
export function fixHint(recs, runId) {
  const m = matchingFix(recs, runId);
  if (!m) return null;
  const where = (f) => {
    if (f.shared) return `fixed in commit ${String(f.commit || '').slice(0, 7)} (shared)`;
    const n = f.hunks ? f.hunks.length : f.stats ? f.stats.files : 0;
    const unit = f.hunks ? `hunk${n === 1 ? '' : 's'}` : `file${n === 1 ? '' : 's'}`;
    const files = (f.hunks ? [...new Set(f.hunks.map((h) => h.location.split(':')[0]))] : f.files || []).slice(0, 2).join(', ');
    return `fixed on ${day(f.ts)} in ${n} ${unit}${files ? ` (${files})` : ''}`;
  };
  const f = m.fix;
  if (m.exact) return `seen before · ${where(f)} · kerb show fix:${short(f.id)} (${f.shared ? 'shared' : f.confidence})`;
  return `similar failure fixed before · kerb show fix:${short(f.id)} (not the same error)`;
}

/**
 * Attach the commit that contains each uncommitted fix (7.6): the oldest of the recent commits on
 * HEAD whose files match the fix's end state, if HEAD still matches it.
 * @returns {any[]} updated fix records to append
 */
export function attachCommits(root, recs) {
  const out = [];
  for (const f of latestFixes(recs)) {
    if (f.commit || f.shared || !f.to_state || !f.files || !f.files.length) continue;
    const to = readState(root, f.to_state);
    if (!to || !to.tree) continue;
    const blobs = (treeish) => {
      const r = git(root, ['ls-tree', '-r', treeish, '--', ...f.files], { encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    };
    const want = blobs(to.tree);
    if (want === null || blobs('HEAD') !== want) continue;
    const log = git(root, ['log', '--format=%H', '-n', '30', 'HEAD', '--', ...f.files], { encoding: 'utf8' });
    let commit = null;
    for (const c of log.stdout.split('\n').filter(Boolean)) {
      if (blobs(c) === want) commit = c;
      else break;
    }
    if (commit) out.push({ ...f, ts: now(), commit });
  }
  return out;
}

/** The note body for a fix: ids only, no code, output or paths beyond test ids (7.7). */
export function noteEntry(f) {
  return JSON.stringify({ fingerprint: f.fingerprint, family: f.family, test_ids: f.test_ids || [], kerb_version: VERSION });
}

/** Add committed fixes to refs/notes/kerb (only when sharing is on). */
export function writeNotes(root, fixes) {
  let n = 0;
  for (const f of fixes) {
    if (!f.commit) continue;
    const entry = noteEntry(f);
    const cur = git(root, ['notes', `--ref=${NOTES_REF}`, 'show', f.commit], { encoding: 'utf8' });
    if (cur.status === 0 && cur.stdout.split('\n').includes(entry)) continue;
    const r = git(root, ['-c', 'user.name=kerb', '-c', 'user.email=kerb@localhost', 'notes', `--ref=${NOTES_REF}`, 'append', '-m', entry, f.commit], { encoding: 'utf8' });
    if (r.status === 0) n++;
  }
  return n;
}

/** Fixes shared by others: entries of a notes ref, as fix records (no states, no diff). */
export function notesFixes(root, ref, known = []) {
  const list = git(root, ['notes', `--ref=${ref}`, 'list'], { encoding: 'utf8' });
  if (list.status !== 0) return [];
  const have = new Set(known.filter((f) => f.shared).map((f) => `${f.commit}\0${f.fingerprint}`));
  const out = [];
  for (const line of list.stdout.split('\n').filter(Boolean)) {
    const [, commit] = line.split(' ');
    const body = git(root, ['notes', `--ref=${ref}`, 'show', commit], { encoding: 'utf8' });
    if (body.status !== 0) continue;
    for (const l of body.stdout.split('\n').filter(Boolean)) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (!e || typeof e.fingerprint !== 'string') continue;
      if (have.has(`${commit}\0${e.fingerprint}`)) continue;
      have.add(`${commit}\0${e.fingerprint}`);
      out.push({ type: 'fix', id: newId(), ts: now(), key: null, fingerprint: e.fingerprint, family: e.family || null, test_ids: Array.isArray(e.test_ids) ? e.test_ids : [],
        from_state: null, to_state: null, hunks: null, files: [], commit, confidence: 'shared', shared: true });
    }
  }
  return out;
}
