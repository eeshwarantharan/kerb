// Shared pieces of the transcript readers (KERB-V2 10.1). Each reader turns one agent session
// into a timeline of events:
//   { kind: 'shell', id, ts, end_ts, command, cwd, exit, output, interrupted, timed_out, background, tokens }
//   { kind: 'edit', ts, tool }   a file-edit tool call
//   { kind: 'tool', ts, tool }   any other tool call (reads and searches; neutral for replay)
// `tokens` is the measured context growth the command's output caused (see shareGrowth), or null.
import fs from 'node:fs';
import path from 'node:path';

/** Read a JSONL file into parsed records, skipping lines that aren't JSON. */
export function jsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn or foreign line */ }
  }
  return out;
}

/** Is `p` the repo root or inside it? */
export function within(root, p) {
  if (typeof p !== 'string' || !p) return false;
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function tsOf(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Files directly in a directory (optionally recursive), with mtime, newer than `sinceTs`. */
export function filesIn(dir, { ext = ['.jsonl'], recursive = false, sinceTs = 0, depth = 0 } = {}) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < 6) out.push(...filesIn(p, { ext, recursive, sinceTs, depth: depth + 1 }));
      continue;
    }
    if (!ext.some((x) => e.name.endsWith(x))) continue;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= sinceTs) out.push({ path: p, mtime: st.mtimeMs });
    } catch { /* gone */ }
  }
  return out;
}

/**
 * Measured tokens per tool result. An agent re-sends the whole context on every model call, so
 * the input of call B minus (input + carried-over output) of the call A before it is what the
 * tool results between them added. That growth is split across those results by size.
 * @param {{ inTokens: number, outTokens: number }[]} calls model calls in order
 * @param {{ call: number, bytes: number, set: (tokens: number | null) => void }[]} results
 *   `call` is the index of the call that requested the tool
 */
export function shareGrowth(calls, results) {
  const byCall = new Map();
  for (const r of results) {
    if (!byCall.has(r.call)) byCall.set(r.call, []);
    byCall.get(r.call).push(r);
  }
  for (const [i, group] of byCall) {
    const a = calls[i];
    const b = calls[i + 1];
    const growth = a && b ? b.inTokens - a.inTokens - a.outTokens : null;
    const total = group.reduce((s, r) => s + r.bytes, 0);
    for (const r of group) {
      r.set(growth != null && growth > 0 && total > 0 ? Math.round((growth * r.bytes) / total) : null);
    }
  }
}

/** Text of a tool result body that may be a string or a list of parts. */
export function partsText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  if (typeof v === 'object' && typeof v.text === 'string') return v.text;
  return '';
}
