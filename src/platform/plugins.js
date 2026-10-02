// Plugins (KERB-V2 11.3): ES modules listed with their SHA-256 in the managed config, the org
// bundle or the repo policy. A repo-listed plugin also needs a person's approval of that hash
// (`kerb plugins approve`). Unlisted or changed files never load. Handlers get a read-only
// query object and may return { note } and nothing else; each has 50 ms, and a timeout or error
// skips it and is counted, never raised.
//
// What runs is exactly what was hashed: Kerb reads the file once, checks its hash, and imports
// those bytes (as a data: URL), so a plugin is one file that may import only Node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../util/core.js';
import { homeKerbDir, readJson, atomicWrite } from '../util/fsx.js';
import { openQuery } from './query.js';
import { VERSION } from '../version.js';
import { pluginsListed as hasPlugins } from '../engine.js';

export const EVENTS = ['run.end', 'refusal', 'finding', 'session.start'];
export const BUDGET_MS = 50;
export const MAX_NOTE = 200;
const MAX_NOTES_PER_EVENT = 3;

/** Every listed plugin: managed config first, then the org bundle and repo policy (from the merged policy). */
export function listedPlugins(root, config, policy) {
  const out = [];
  const managed = config && config.managed && Array.isArray(config.managed.plugins) ? config.managed.plugins : [];
  for (const x of managed) {
    if (x && typeof x.path === 'string' && typeof x.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(x.sha256)) out.push({ path: x.path, sha256: x.sha256.toLowerCase(), layer: 'managed', source: 'managed config' });
  }
  out.push(...((policy && policy.plugins) || []));
  const seen = new Set();
  return out.map((p) => ({ ...p, file: path.resolve(root, p.path) })).filter((p) => (seen.has(p.file) ? false : seen.add(p.file)));
}

export { hasPlugins };

const approvalsFile = () => path.join(homeKerbDir({ create: false }), 'plugins-approved.json');

/** Approvals of repo-listed plugins: file → sha256. */
export function approvals() {
  const a = readJson(approvalsFile(), null);
  return a && a.approved && typeof a.approved === 'object' ? a.approved : {};
}

export function setApproval(file, hash) {
  const a = approvals();
  if (hash) a[file] = hash;
  else delete a[file];
  homeKerbDir({ create: true });
  atomicWrite(approvalsFile(), `${JSON.stringify({ version: 1, approved: a }, null, 2)}\n`);
}

/**
 * Each listed plugin with whether it may load and why not.
 * @returns {{ path: string, file: string, sha256: string, layer: string, source: string, status: 'ok'|'needs_approval'|'hash_mismatch'|'missing', actual: string | null, bytes?: Buffer }[]}
 */
export function pluginStatus(root, config, policy) {
  const ok = approvals();
  return listedPlugins(root, config, policy).map((p) => {
    let bytes = null;
    try { bytes = fs.readFileSync(p.file); } catch { return { ...p, status: 'missing', actual: null }; }
    const actual = sha256(bytes);
    if (actual !== p.sha256) return { ...p, status: 'hash_mismatch', actual };
    if (p.layer === 'repo' && ok[p.file] !== p.sha256) return { ...p, status: 'needs_approval', actual, bytes };
    return { ...p, status: 'ok', actual, bytes };
  });
}

/** One line about a plugin that won't load. */
export function statusWarning(p) {
  if (p.status === 'hash_mismatch') return `plugin ${p.path} not loaded: the file changed since it was listed (sha256 ${p.actual.slice(0, 12)}…, listed ${p.sha256.slice(0, 12)}…)`;
  if (p.status === 'needs_approval') return `plugin ${p.path} not loaded: a person must approve it first (kerb plugins approve ${p.path})`;
  if (p.status === 'missing') return `plugin ${p.path} not loaded: no such file`;
  return null;
}

// Indirect so bundlers (scripts/bundle.js refuses computed imports) leave this one alone.
const IMPORT = 'import';
const importer = new Function('s', `return ${IMPORT}(s)`);

/** Loaded plugins per root, for this process. */
const cache = new Map();

/**
 * Load the plugins that may run.
 * @returns {Promise<{ plugins: { name: string, file: string, events: Record<string, Function> }[], warnings: string[] }>}
 */
export async function loadPlugins(root, config, policy) {
  const statuses = pluginStatus(root, config, policy);
  const key = `${root}\0${statuses.map((s) => `${s.file}:${s.status}:${s.actual}`).join('|')}`;
  if (cache.has(key)) return cache.get(key);
  const warnings = statuses.map(statusWarning).filter(Boolean);
  const plugins = [];
  for (const s of statuses.filter((x) => x.status === 'ok')) {
    try {
      const mod = await importer(`data:text/javascript;base64,${s.bytes.toString('base64')}`);
      const def = mod && mod.default;
      if (!def || typeof def !== 'object' || !def.events || typeof def.events !== 'object') { warnings.push(`plugin ${s.path} not loaded: it has no default export { name, events }`); continue; }
      const name = typeof def.name === 'string' && /^[\w.@/-]{1,64}$/.test(def.name) ? def.name : path.basename(s.file).replace(/\.[cm]?js$/, '');
      const events = {};
      for (const e of EVENTS) if (typeof def.events[e] === 'function') events[e] = def.events[e];
      plugins.push({ name, file: s.file, events });
    } catch (e) {
      warnings.push(`plugin ${s.path} not loaded: ${String(e && e.message ? e.message : e).split('\n')[0].slice(0, 160)}`);
    }
  }
  const r = { plugins, warnings };
  cache.set(key, r);
  return r;
}

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); }
  return v;
};

/** The read-only query object plugins get: the query layer's answers, copied and frozen. */
export function readOnlyQuery(root, env) {
  const q = openQuery({ cwd: root, env });
  const wrap = (fn) => (...args) => deepFreeze(structuredClone(fn(...args)));
  return Object.freeze(Object.fromEntries(['runs', 'tests', 'verification', 'progress', 'fixes', 'findings', 'states', 'attempts', 'testHistory', 'lastGreen', 'boundaries', 'explain'].map((k) => [k, wrap(q[k])])));
}

/** A handler's result reduced to what plugins may contribute: one line of advisory text. */
function noteOf(r) {
  if (!r || typeof r !== 'object' || typeof r.note !== 'string') return null;
  const t = r.note.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, MAX_NOTE) : null;
}

/**
 * Run one event's handlers.
 * @param {{ name: string, events: Record<string, Function> }[]} plugins
 * @returns {Promise<{ notes: { plugin: string, text: string }[], counts: Record<string, { calls: number, timeouts: number, errors: number }> }>}
 */
export async function runEvent(plugins, event, payload, ctx) {
  const notes = [];
  const counts = {};
  const data = deepFreeze(structuredClone(payload));
  for (const p of plugins) {
    const h = p.events[event];
    if (!h) continue;
    const c = counts[p.name] || (counts[p.name] = { calls: 0, timeouts: 0, errors: 0 });
    c.calls++;
    const t0 = performance.now();
    let timer;
    try {
      const out = await Promise.race([
        Promise.resolve().then(() => h(ctx, data)),
        new Promise((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), BUDGET_MS); }),
      ]);
      // A synchronous handler can't be interrupted; one that overran still doesn't count.
      if (out === TIMEOUT || performance.now() - t0 > BUDGET_MS) { c.timeouts++; continue; }
      const text = noteOf(out);
      if (text && notes.length < MAX_NOTES_PER_EVENT) notes.push({ plugin: p.name, text });
    } catch {
      c.errors++;
    } finally {
      clearTimeout(timer);
    }
  }
  return { notes, counts };
}
const TIMEOUT = Symbol('timeout');

/**
 * Fire events for a prepared command (engine prep) and return note lines ("[name] text") to show.
 * Does nothing (and loads nothing) when no plugin is listed. Never throws.
 * @param {any} prep
 * @param {[string, any][]} events
 * @param {{ warnings?: boolean }} [o] warnings: include lines about plugins that didn't load
 * @returns {Promise<string[]>}
 */
export async function pluginNotes(prep, events, o = {}) {
  if (!hasPlugins(prep)) return [];
  try {
    const { plugins, warnings } = await loadPlugins(prep.root, prep.config, prep.policy);
    const lines = o.warnings ? [...warnings] : [];
    if (!plugins.length) return lines;
    const ctx = Object.freeze({ query: readOnlyQuery(prep.root, prep.ctx ? prep.ctx.env : process.env), repo: prep.root, kerb_version: VERSION });
    const total = {};
    for (const [event, payload] of events) {
      const r = await runEvent(plugins, event, payload, ctx);
      lines.push(...r.notes.map((n) => `[${n.plugin}] ${n.text}`));
      for (const [name, c] of Object.entries(r.counts)) {
        const t = total[name] || (total[name] = { calls: 0, timeouts: 0, errors: 0 });
        t.calls += c.calls; t.timeouts += c.timeouts; t.errors += c.errors;
      }
    }
    if (Object.keys(total).length && prep.store) {
      prep.store.updateSummary((s) => {
        s.plugins = s.plugins || {};
        for (const [name, c] of Object.entries(total)) {
          const t = s.plugins[name] || { calls: 0, timeouts: 0, errors: 0 };
          s.plugins[name] = { calls: t.calls + c.calls, timeouts: t.timeouts + c.timeouts, errors: t.errors + c.errors };
        }
      });
    }
    return lines;
  } catch {
    return [];
  }
}

/** The events after a command: run.end with the run (as KER) and its failing tests, then each finding delivered. */
export function afterEvents(prep, runId, findings = []) {
  if (!hasPlugins(prep)) return [];
  const events = [];
  try {
    const r = openQuery({ cwd: prep.root, env: prep.ctx ? prep.ctx.env : process.env }).explain(runId);
    if (r.run) events.push(['run.end', { run: r.run, failing: r.failing }]);
  } catch { /* no run.end */ }
  for (const f of findings) { const { crc, ...x } = f; void crc; events.push(['finding', x]); }
  return events;
}
