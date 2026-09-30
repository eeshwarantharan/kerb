// kerb statusline [--segment]: one line under 80 characters, read only from summary.json.
import fs from 'node:fs';
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { loadSummary, currentSession, emptyCounters } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderStatusline } from '../ui/recap.js';
import { parseOpts } from './args.js';

/** Agents pass status-line JSON on stdin; read it only when stdin is a pipe with data. */
function stdinJson(ctx) {
  let text = ctx.stdin;
  if (text === undefined) {
    if (process.stdin.isTTY) return null;
    try { text = fs.readFileSync(0, 'utf8'); } catch { return null; }
  }
  try { return text && text.trim() ? JSON.parse(text) : null; } catch { return null; }
}

export default async function statusline(ctx, args) {
  const { opts } = parseOpts(args, { segment: 'bool' });
  const input = stdinJson(ctx);
  const cwd = (input && (input.cwd || (input.workspace && input.workspace.current_dir))) || ctx.cwd;
  const { root } = findRoot(cwd);
  const summary = loadSummary(path.join(root, '.kerb'));
  const id = input && input.session_id;
  const session = id && summary.sessions[id] ? { id, ...summary.sessions[id] } : id ? { id, counters: emptyCounters() } : currentSession(summary);
  const off = loadConfig().values.statusline === 'off';
  const line = off ? '' : renderStatusline(summary, session, { segment: !!opts.segment });
  if (ctx.json) ctx.emitJson({ line, session: session.id });
  else if (line) ctx.out(`${line}\n`);
  return 0;
}
