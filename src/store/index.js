// Derived indexes (KERB-V2 5.2) in .kerb/index/, rebuilt from the event log at any time.
// Writers (hooks, kerb run) never touch them: a reader catches them up from the byte position
// it last reached, under the store lock. Applying a record twice changes nothing, so a crash
// between writing two index files can't double-count.
//   by_key.json        last 50 runs per key
//   tests.json         last 20 results per test id
//   states.json        state → runs, and green or red per key
//   fixes.json         fingerprint and family → fix ids
//   verification.json  the latest run of each check key (its state and result)
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite, ensureDir } from '../util/fsx.js';

export const INDEX_VERSION = 1;
export const FILES = ['by_key', 'tests', 'states', 'fixes', 'verification'];
const RUNS_PER_KEY = 50;
const RESULTS_PER_TEST = 20;
const RUNS_PER_STATE = 50;
const MAX_OPEN = 500;

export function emptyIndexes() {
  return {
    meta: { version: INDEX_VERSION, rotations: 0, offset: 0, open: {} },
    by_key: {},
    tests: {},
    states: {},
    fixes: { by_fingerprint: {}, by_family: {} },
    verification: {},
  };
}

const pushUnique = (list, item, cap, same = (x) => x.id === item.id) => {
  const i = list.findIndex(same);
  if (i !== -1) list.splice(i, 1);
  list.push(item);
  if (list.length > cap) list.splice(0, list.length - cap);
};

function runSummary(r) {
  const out = {
    id: r.id, ts: r.end_ts ?? r.ts, session: r.session ?? null, class: r.class ?? null,
    pre_state: r.pre_hash ?? null, post_state: r.post_hash ?? null,
    exit: r.type === 'wait' ? r.final_exit ?? null : r.exit ?? null,
    class_result: r.class_result ?? null, failure_kind: r.failure_kind ?? null, fingerprint: r.fingerprint ?? null,
    duration_ms: r.duration_ms ?? null,
  };
  if (r.framework) out.framework = r.framework;
  if (r.tests_summary) out.tests_summary = r.tests_summary;
  return out;
}

function addRun(ix, key, run) {
  if (!key) return;
  ix.by_key[key] = ix.by_key[key] || [];
  pushUnique(ix.by_key[key], run, RUNS_PER_KEY);
  const green = run.exit === 0 && (run.class_result === 'ok' || run.class_result == null);
  if (run.post_state) {
    const s = ix.states[run.post_state] || (ix.states[run.post_state] = { runs: [], keys: {} });
    if (!s.runs.includes(run.id)) s.runs.push(run.id);
    if (s.runs.length > RUNS_PER_STATE) s.runs.splice(0, s.runs.length - RUNS_PER_STATE);
    if (run.exit != null) s.keys[key] = green ? 'green' : 'red';
  }
  if (run.class === 'check' && run.exit != null) {
    ix.verification[key] = { run: run.id, state: run.post_state, result: green ? 'pass' : 'fail', ts: run.ts };
  }
}

/** Fold records into the indexes (same function for catch-up and rebuild). */
export function applyIndex(ix, recs) {
  for (const r of recs) {
    switch (r.type) {
      case 'start': {
        ix.meta.open[r.id] = { id: r.id, ts: r.ts, key: r.key, class: r.class, session: r.session ?? null, pre_hash: r.pre_hash ?? null };
        const ids = Object.keys(ix.meta.open);
        if (ids.length > MAX_OPEN) for (const id of ids.slice(0, ids.length - MAX_OPEN)) delete ix.meta.open[id];
        break;
      }
      case 'end': {
        const s = ix.meta.open[r.id];
        if (!s) break;
        delete ix.meta.open[r.id];
        addRun(ix, s.key || r.key, runSummary({ ...s, ...r, type: 'end', end_ts: r.ts }));
        break;
      }
      case 'wait':
        addRun(ix, r.key, runSummary(r));
        break;
      case 'test_result': {
        if (!r.test_id) break;
        ix.tests[r.test_id] = ix.tests[r.test_id] || [];
        pushUnique(ix.tests[r.test_id], { run: r.run, status: r.status, state: r.state ?? null, key: r.key ?? null, ts: r.ts ?? null }, RESULTS_PER_TEST, (x) => x.run === r.run);
        break;
      }
      case 'fix': {
        const add = (map, k) => { if (!k) return; map[k] = map[k] || []; if (!map[k].includes(r.id)) map[k].push(r.id); };
        add(ix.fixes.by_fingerprint, r.fingerprint);
        add(ix.fixes.by_family, r.family);
        break;
      }
      default:
        break; // other and unknown record types don't feed an index
    }
  }
  return ix;
}

export function indexDir(store) {
  return path.join(store.dir, 'index');
}

function readIndexes(store) {
  const dir = indexDir(store);
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    if (!meta || meta.version !== INDEX_VERSION) return null;
    const ix = { meta };
    for (const f of FILES) ix[f] = JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), 'utf8'));
    return ix;
  } catch {
    return null; // missing or damaged: rebuilt
  }
}

export function writeIndexes(store, ix) {
  const dir = ensureDir(indexDir(store));
  for (const f of FILES) atomicWrite(path.join(dir, `${f}.json`), JSON.stringify(ix[f]));
  atomicWrite(path.join(dir, 'meta.json'), JSON.stringify(ix.meta)); // last: it marks how far the files got
}

function rebuildUnlocked(store) {
  const ix = emptyIndexes();
  const r = store.readFrom(0, 0);
  applyIndex(ix, r.recs);
  ix.meta.rotations = r.rotations;
  ix.meta.offset = r.offset;
  writeIndexes(store, ix);
  return ix;
}

/** Rebuild every index from the whole event log (`kerb reindex`). */
export function rebuildIndexes(store) {
  store.ensure();
  return store.withLock(() => rebuildUnlocked(store));
}

/**
 * The indexes, caught up with the event log. Missing, damaged or out-of-date indexes are
 * rebuilt automatically.
 */
export function loadIndexes(store) {
  if (!fs.existsSync(store.file) && !store.rotatedFiles().length) return emptyIndexes();
  return store.withLock(() => {
    const ix = readIndexes(store);
    if (!ix) return rebuildUnlocked(store);
    const r = store.readFrom(ix.meta.rotations, ix.meta.offset);
    if (r.reset) return rebuildUnlocked(store);
    if (!r.recs.length && r.offset === ix.meta.offset && r.rotations === ix.meta.rotations) return ix;
    applyIndex(ix, r.recs);
    ix.meta.rotations = r.rotations;
    ix.meta.offset = r.offset;
    writeIndexes(store, ix);
    return ix;
  });
}
