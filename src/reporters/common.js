// Shared pieces of the reporter parsers (KERB-V2 5.4). A parser takes ANSI-stripped output and
// returns { framework, results, summary } or null when it doesn't recognise the output. Each
// result is { file, name, status, location, message, duration_ms }; the registry turns
// file + name into the test id. Parsers never throw on odd input: the registry catches and
// records `framework: unknown`.
import path from 'node:path';

export class ParseBudget extends Error {}

/** Iterate lines, checking the deadline every 2,000 lines. */
export function* lines(text, deadline) {
  let i = 0;
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const line = nl === -1 ? text.slice(start) : text.slice(start, nl);
    if ((++i % 2000) === 0 && deadline && Date.now() > deadline) throw new ParseBudget('reporter parse budget exceeded');
    yield line.endsWith('\r') ? line.slice(0, -1) : line;
    if (nl === -1) return;
    start = nl + 1;
  }
}

/**
 * A repo-relative path with forward slashes: absolute paths (and file:// URLs) are made relative
 * to the repo root, relative ones are resolved against the command's directory first.
 */
export function repoPath(p, ctx) {
  if (!p) return '';
  let s = String(p).replace(/^file:\/\//, '');
  if (!path.isAbsolute(s)) s = path.resolve(ctx.cwd || ctx.root || '.', s);
  const rel = path.relative(ctx.root || ctx.cwd || '.', s);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return s.split(path.sep).join('/');
  return rel.split(path.sep).join('/');
}

export const STATUS = {
  pass: 'pass', passed: 'pass', ok: 'pass', success: 'pass',
  fail: 'fail', failed: 'fail', failure: 'fail',
  skip: 'skip', skipped: 'skip', pending: 'skip', todo: 'skip', disabled: 'skip', ignored: 'skip',
  error: 'error', errored: 'error',
};

export function summarize(results, counts = null) {
  const s = { passed: 0, failed: 0, skipped: 0, errors: 0, total: 0 };
  for (const r of results) {
    if (r.status === 'pass') s.passed++;
    else if (r.status === 'fail') s.failed++;
    else if (r.status === 'skip') s.skipped++;
    else if (r.status === 'error') s.errors++;
  }
  s.total = results.length;
  // A reporter's own totals win: most reporters list only failures.
  if (counts) for (const k of Object.keys(s)) if (Number.isInteger(counts[k])) s[k] = counts[k];
  if (counts && !Number.isInteger(counts.total)) s.total = s.passed + s.failed + s.skipped + s.errors;
  return s;
}

/** Diagnostics (tsc, ESLint, Ruff, mypy, Clippy) as pseudo-tests: one per file and rule. */
export function diagnostics(framework, items) {
  const by = new Map();
  for (const d of items) {
    const k = `${d.file}\0${d.rule}`;
    if (!by.has(k)) by.set(k, { file: d.file, name: d.rule, status: 'fail', location: d.location, message: d.message, duration_ms: null, count: 0 });
    by.get(k).count++;
  }
  const results = [...by.values()];
  return { framework, results, summary: { passed: 0, failed: results.length, skipped: 0, errors: 0, total: results.length } };
}
