// Reporter registry (KERB-V2 5.4): turn a check command's output (and any structured report
// file it wrote) into test-level results. Never fails a run: an error, an unknown format or a
// blown budget gives `null` (the run is recorded with `framework: unknown`).
import fs from 'node:fs';
import path from 'node:path';
import { stripAnsi } from '../run/shape.js';
import { redactText } from '../run/redact.js';
import { ParseBudget } from './common.js';
import * as vitest from './vitest.js';
import * as jest from './jest.js';
import * as pytest from './pytest.js';
import * as gotest from './go.js';
import * as cargo from './cargo.js';
import * as nodetest from './node.js';
import * as tsc from './tsc.js';
import * as eslint from './eslint.js';
import * as ruff from './ruff.js';
import * as mypy from './mypy.js';
import * as clippy from './clippy.js';
import * as junit from './junit.js';

export const PARSERS = [vitest, jest, pytest, nodetest, gotest, cargo, tsc, eslint, ruff, mypy, clippy];
/** Parse budget: 100 ms per MB of output, at least 100 ms (12). */
export const MS_PER_MB = 100;
export const MAX_RESULTS = 2000;
const MAX_TEXT = 64 * 1024 * 1024;

/** Which parser the command names, if any (`npx vitest run`, `python -m pytest`, `cargo clippy`…). */
export function hintFor(command) {
  const c = ` ${String(command || '')} `;
  if (/\svitest\s/.test(c)) return vitest;
  if (/\sjest\s/.test(c)) return jest;
  if (/\spytest\s|python3? -m pytest/.test(c)) return pytest;
  if (/\sgo test\s/.test(c)) return gotest;
  if (/\scargo clippy\s/.test(c)) return clippy;
  if (/\scargo test\s/.test(c)) return cargo;
  if (/\snode (?:[^|;&]*\s)?--test\b/.test(c)) return nodetest;
  if (/\stsc\s/.test(c)) return tsc;
  if (/\seslint\s/.test(c)) return eslint;
  if (/\sruff check\s/.test(c)) return ruff;
  if (/\smypy\s/.test(c)) return mypy;
  return null;
}

/** Structured report files named on the command line: `--outputFile`, `--junitxml`, `--junit-xml`. */
export function reportFlags(command) {
  const out = [];
  const re = /--(outputFile|junitxml|junit-xml|output-file)(?:=|\s+)(\S+)/g;
  let m;
  while ((m = re.exec(String(command || '')))) out.push({ flag: m[1], file: m[2].replace(/^["']|["']$/g, '') });
  return out;
}

const REPORT_NAME = /^(TEST-.*|junit.*)\.xml$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', '.kerb', '.venv', 'venv', '__pycache__']);

/** JUnit XML files written since `sinceMs`, at most 3 levels below `dir` (bounded walk). */
export function recentReports(dir, sinceMs, { maxEntries = 3000 } = {}) {
  const out = [];
  let seen = 0;
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > maxEntries) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3 && !SKIP_DIRS.has(e.name)) walk(p, depth + 1); continue; }
      if (!REPORT_NAME.test(e.name)) continue;
      try { if (fs.statSync(p).mtimeMs >= sinceMs) out.push(p); } catch { /* gone */ }
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * @param {{ command: string, text: string, cwd: string, root: string, startedAt?: number,
 *   deadline?: number }} o
 * @returns {{ framework: string, results: any[], summary: any, truncated?: boolean } | null}
 */
export function parseResults(o) {
  const text = o.text && o.text.length > MAX_TEXT ? null : stripAnsi(o.text || '');
  const deadline = o.deadline ?? Date.now() + Math.max(MS_PER_MB, Math.round((MS_PER_MB * Buffer.byteLength(o.text || '')) / 1e6));
  const ctx = { cwd: o.cwd, root: o.root, command: o.command, deadline };
  let r = null;
  try {
    r = fromReportFiles(o, ctx);
    if (!r && text) {
      const hint = hintFor(o.command);
      if (hint) r = hint.parse(text, ctx);
      if (!r) for (const p of PARSERS) { if (p === hint) continue; r = p.parse(text, ctx); if (r) break; }
    }
  } catch (e) {
    if (e instanceof ParseBudget) return null;
    return null;
  }
  if (!r || !r.results) return null;
  return finish(r);
}

function fromReportFiles(o, ctx) {
  const files = [];
  for (const f of reportFlags(o.command)) files.push(path.resolve(o.cwd, f.file));
  if (o.startedAt) files.push(...recentReports(o.cwd, o.startedAt - 1000));
  for (const f of [...new Set(files)]) {
    let body;
    try {
      const st = fs.statSync(f);
      if (o.startedAt && st.mtimeMs < o.startedAt - 1000) continue;
      if (st.size > MAX_TEXT) continue;
      body = fs.readFileSync(f, 'utf8');
    } catch { continue; }
    const r = /^\s*</.test(body) ? junit.parse(body, ctx) : jest.parseJson(body, ctx);
    if (r) return r;
  }
  return null;
}

/** Test ids, redacted and truncated messages, and the result cap. */
function finish(r) {
  let results = r.results.map((x) => ({
    test_id: `${r.framework}:${x.file || ''}::${x.name}`,
    status: x.status,
    location: x.location || null,
    message: x.message ? truncate(redactText(String(x.message).trim().split('\n')[0]), 200) : null,
    duration_ms: Number.isFinite(x.duration_ms) ? Math.round(x.duration_ms * 1000) / 1000 : null,
  }));
  // One result per test id (a later line about the same test refines an earlier one).
  const by = new Map();
  for (const x of results) by.set(x.test_id, { ...(by.get(x.test_id) || {}), ...Object.fromEntries(Object.entries(x).filter(([, v]) => v != null)) });
  results = [...by.values()].map((x) => ({ test_id: x.test_id, status: x.status, location: x.location ?? null, message: x.message ?? null, duration_ms: x.duration_ms ?? null }));
  let truncated = false;
  if (results.length > MAX_RESULTS) {
    truncated = true;
    const notPass = results.filter((x) => x.status !== 'pass');
    results = [...notPass, ...results.filter((x) => x.status === 'pass')].slice(0, MAX_RESULTS);
  }
  return { framework: r.framework, results, summary: { ...r.summary, ...(truncated ? { truncated: true } : {}) } };
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
