// Cause isolation and fix minimisation (KERB-V2 8.2), with the same machinery:
//   cause:    a test passed on state G and fails on B; which hunks of G → B break it?
//   minimize: a fix turned a failure F green on G; which hunks of F → G are needed?
// Both reproduce first, search with ddmin, confirm with one more probe, and stay within the job's
// probe and time budget. Nothing is ever applied to the working tree.
import { newId, now } from '../util/core.js';
import { readState } from '../state/keep.js';
import { Store } from '../store/jsonl.js';
import { loadPolicy } from '../bound/load.js';
import { envStampForKey } from '../insight/verify.js';
import { Bench } from './probe.js';
import { ddmin, Budget } from './ddmin.js';
import { narrowCommand } from './narrow.js';

/** Where a hunk changes the file: the changed lines on the new side (context left out). */
export function hunkLocation(bench, id) {
  const h = bench.diff.hunks.find((x) => x.id === id);
  if (!h) return id;
  if (h.whole) return h.file;
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h.header);
  if (!m) return h.file;
  let line = Number(m[1]);
  let first = null;
  let last = null;
  for (const l of h.lines) {
    if (l.startsWith('+')) { first = first ?? line; last = line; line++; } else if (l.startsWith('-')) { first = first ?? line; last = last ?? line; } else if (!l.startsWith('\\')) line++;
  }
  if (first == null) return h.file;
  return last > first ? `${h.file}:${first}–${last}` : `${h.file}:${first}`;
}

function budgets(config, narrowed) {
  const max = Number(config.values.cause_max_probes) || 12;
  return { maxProbes: narrowed ? max : Math.max(4, Math.floor(max / 2)), maxMs: (Number(config.values.cause_max_seconds) || 180) * 1000 };
}

/** Isolate the cause of a newly failing test. Appends a `finding` record. */
export async function isolate(o) {
  const p = o.job.payload;
  const store = new Store(o.root);
  const policy = loadPolicy(o.root, o.config, now());
  const finding = {
    type: 'finding', id: newId(), ts: now(), kind: 'cause', key: p.key, test_id: p.test_id, good_state: p.good_state, bad_state: p.bad_state,
    good_run: p.good_run || null, bad_run: p.bad_run || null, attempt: p.attempt || null, culprit_hunks: [], locations: [], hunk_count: 0, probes: 0,
    confidence: 'undetermined', reason_if_undetermined: null, narrowed: null,
  };
  const done = (reason) => {
    if (reason) finding.reason_if_undetermined = reason;
    finding.ts = now();
    store.append([finding], (s) => { s.findings_pending = (s.findings_pending || 0) + 1; });
    return { finding: finding.id, confidence: finding.confidence, reason: finding.reason_if_undetermined, probes: finding.probes };
  };
  const good = readState(o.root, p.good_state);
  const bad = readState(o.root, p.bad_state);
  if (!good || !bad) return done('a state is no longer kept');
  if (!good.materializable || !bad.materializable) return done('not materializable (a file over 5 MB)');
  const envNow = envStampForKey(o.root, p.key, policy, o.env);
  if (good.env_stamp !== bad.env_stamp || envNow !== bad.env_stamp) return done('dependencies changed');
  const narrowed = narrowCommand(p.test_id, p.command);
  finding.narrowed = narrowed;
  const b = budgets(o.config, !!narrowed);
  const bench = new Bench({ root: o.root, job: o.job, base: good, target: bad, command: narrowed || p.command, cwdRel: p.cwd_rel || '.', testIds: [p.test_id],
    env: o.env, envStamp: envNow, maxProbes: b.maxProbes, deadline: Date.now() + b.maxMs, control: o.control, stopping: o.stopping, links: policy.worktree_links.length ? policy.worktree_links : undefined });
  try {
    const s = bench.setup();
    if (!s.ok) return done(s.reason);
    const all = s.hunks;
    finding.hunk_count = all.length;
    if (!all.length) return done('no changes in scope between the two states');
    // Reproduce: fails twice on B, passes once on G.
    const f1 = await bench.probe(all, { fresh: true });
    const f2 = await bench.probe(all, { fresh: true });
    const g1 = await bench.probe([], { fresh: true });
    if (f1 !== 'fail' || f2 !== 'fail' || g1 !== 'pass') { finding.probes = bench.probes; return done('not reproducible in isolation'); }
    let culprit;
    try {
      culprit = await ddmin(all, (sub) => bench.probe(sub));
    } catch (e) {
      if (!(e instanceof Budget)) throw e;
      finding.probes = bench.probes;
      finding.culprit_hunks = e.best || all;
      finding.locations = finding.culprit_hunks.map((id) => hunkLocation(bench, id));
      finding.partial = true;
      return done('interdependent changes (budget exhausted; the smallest failing set found so far)');
    }
    // Confirm, on fresh runs: B without exactly the culprit set passes twice, and G with only the
    // culprit set fails. A flaky test rarely survives all three (found by bench/cause.js: one
    // probe let a 50% flaky test blame an innocent hunk).
    let confirmed = false;
    try {
      const rest = all.filter((h) => !culprit.includes(h));
      confirmed = (await bench.probe(rest, { fresh: true })) === 'pass'
        && (await bench.probe(rest, { fresh: true })) === 'pass'
        && (culprit.length === all.length || (await bench.probe(culprit, { fresh: true })) === 'fail');
    } catch (e) { if (!(e instanceof Budget)) throw e; confirmed = false; }
    finding.probes = bench.probes;
    finding.culprit_hunks = culprit;
    finding.locations = culprit.map((id) => hunkLocation(bench, id));
    if (!confirmed) return done('the culprit set did not confirm');
    finding.confidence = 'confirmed';
    return done(null);
  } finally {
    bench.cleanup();
  }
}

/** Minimise a fix to the hunks it needs, re-verified. Appends an updated `fix` record. */
export async function minimize(o) {
  const p = o.job.payload;
  const store = new Store(o.root);
  const policy = loadPolicy(o.root, o.config, now());
  const fix = (await import('../insight/fixes.js')).latestFix(store.read({ maxBytes: Number.MAX_SAFE_INTEGER }), p.fix_id);
  if (!fix) return { skipped: 'fix not found' };
  const red = readState(o.root, fix.from_state);
  const green = readState(o.root, fix.to_state);
  if (!red || !green || !red.materializable || !green.materializable) return { skipped: 'states not materializable' };
  const envNow = envStampForKey(o.root, fix.key, policy, o.env);
  if (red.env_stamp !== green.env_stamp || envNow !== green.env_stamp) return { skipped: 'dependencies changed' };
  const b = budgets(o.config, false);
  const bench = new Bench({ root: o.root, job: o.job, base: red, target: green, command: p.command, cwdRel: p.cwd_rel || '.', testIds: fix.test_ids,
    env: o.env, envStamp: envNow, maxProbes: Math.max(b.maxProbes, 8), deadline: Date.now() + b.maxMs, control: o.control, stopping: o.stopping });
  try {
    const s = bench.setup();
    if (!s.ok) return { skipped: s.reason };
    const all = s.hunks;
    if (all.length <= 1) {
      store.append([{ ...fix, ts: now(), hunks: all.map((id) => ({ id, location: hunkLocation(bench, id) })), confidence: 'minimal' }]);
      return { hunks: all.length };
    }
    // ddmin finds the smallest subset with the property; here the property is "the tests pass".
    const holds = async (sub) => { const r = await bench.probe(sub); return r === 'pass' ? 'fail' : r === 'fail' ? 'pass' : 'unresolved'; };
    let min;
    try { min = await ddmin(all, holds); } catch (e) { if (e instanceof Budget) return { skipped: 'budget exhausted' }; throw e; }
    let verified = false;
    try { verified = (await bench.probe(min, { fresh: true })) === 'pass'; } catch (e) { if (!(e instanceof Budget)) throw e; }
    if (!verified) return { skipped: 'did not re-verify' };
    store.append([{ ...fix, ts: now(), hunks: min.map((id) => ({ id, location: hunkLocation(bench, id) })), hunk_count: all.length, confidence: 'minimal' }]);
    return { hunks: min.length, of: all.length, probes: bench.probes };
  } finally {
    bench.cleanup();
  }
}

