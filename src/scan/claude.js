// Claude Code transcripts (KERB-V2 10.1). VERIFY 2026-10-01: sessions are JSONL files in
// <config dir>/projects/<encoded cwd>/<session id>.jsonl, where the config dir is
// CLAUDE_CONFIG_DIR or ~/.claude (https://code.claude.com/docs/en/settings) and the encoded cwd
// replaces every non-alphanumeric character with "-". Subagents write
// <session id>/subagents/agent-*.jsonl. Records seen in real files:
//   assistant: message { id, content: [tool_use { id, name, input }], usage { input_tokens,
//              cache_creation_input_tokens, cache_read_input_tokens, output_tokens } }, cwd, timestamp
//   user:      message { content: [tool_result { tool_use_id, content, is_error }] },
//              toolUseResult { stdout, stderr, interrupted } (or an "Error: …" string)
// Failed Bash results start "Exit code N"; timeouts "Command timed out after …".
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { jsonl, within, tsOf, filesIn, shareGrowth, partsText } from './common.js';

export const AGENT = 'claude';
export const NAME = 'Claude Code';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function baseDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

export function encodeCwd(p) {
  return p.replace(/[^A-Za-z0-9]/g, '-');
}

/** Session files for sessions started in the repo root or below it. */
export function sessionFiles(root, { env = process.env, home = os.homedir(), sinceTs = 0 } = {}) {
  const projects = path.join(baseDir(env, home), 'projects');
  const enc = encodeCwd(root);
  let dirs = [];
  try { dirs = fs.readdirSync(projects).filter((d) => d === enc || d.startsWith(`${enc}-`)); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const dir = path.join(projects, d);
    for (const f of filesIn(dir, { sinceTs })) out.push({ ...f, session: path.basename(f.path, '.jsonl') });
    // Subagent transcripts belong to their parent session.
    for (const sub of filesIn(dir, { sinceTs, recursive: true }).filter((f) => f.path.includes(`${path.sep}subagents${path.sep}`))) {
      out.push({ ...sub, session: path.basename(path.dirname(path.dirname(sub.path))), subagent: true });
    }
  }
  return out;
}

const exitOf = (text) => {
  const m = /^(?:Error: )?Exit code (\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};

/**
 * @param {string} file
 * @param {string} root only sessions whose cwd is inside the repo count
 * @returns {{ events: any[], cwd: string | null } | { skipped: string }}
 */
export function readSession(file, root) {
  const recs = jsonl(file);
  if (!recs) return { skipped: 'unreadable' };
  const chat = recs.filter((r) => r && (r.type === 'user' || r.type === 'assistant') && r.message);
  if (!chat.length) return { skipped: 'unrecognised format' };
  const cwd = (chat.find((r) => typeof r.cwd === 'string') || {}).cwd || null;
  if (cwd && !within(root, cwd)) return { skipped: 'outside this repo' };

  const events = [];
  const pending = new Map();
  /** @type {{ id: string, inTokens: number, outTokens: number }[]} */
  const calls = [];
  const callIndex = new Map();
  const results = [];
  const toolCall = new Map(); // tool_use id → call index

  for (const r of chat) {
    const ts = tsOf(r.timestamp);
    const content = Array.isArray(r.message.content) ? r.message.content : [];
    if (r.type === 'assistant') {
      let ci = null;
      const u = r.message.usage;
      const mid = r.message.id || r.requestId || r.uuid;
      if (u && mid && !r.isSidechain) {
        const inTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        if (callIndex.has(mid)) {
          ci = callIndex.get(mid);
          calls[ci].outTokens = Math.max(calls[ci].outTokens, u.output_tokens || 0);
        } else {
          ci = calls.length;
          callIndex.set(mid, ci);
          calls.push({ id: mid, inTokens, outTokens: u.output_tokens || 0 });
        }
      }
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        if (ci != null) toolCall.set(b.id, ci);
        const input = b.input || {};
        if (b.name === 'Bash' && typeof input.command === 'string') {
          const ev = { kind: 'shell', id: b.id, ts, end_ts: null, command: input.command, cwd: r.cwd || cwd, exit: null, output: '', interrupted: false, timed_out: false, background: !!input.run_in_background, tokens: null };
          pending.set(b.id, ev);
          events.push(ev);
        } else if (EDIT_TOOLS.has(b.name)) events.push({ kind: 'edit', ts, tool: b.name });
        else events.push({ kind: 'tool', ts, tool: b.name });
      }
    } else {
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue;
        const text = partsText(b.content);
        if (toolCall.has(b.tool_use_id)) {
          const holder = { call: toolCall.get(b.tool_use_id), bytes: Buffer.byteLength(text), set: () => {} };
          const ev = pending.get(b.tool_use_id);
          if (ev) holder.set = (t) => { ev.tokens = t; };
          results.push(holder);
        }
        const ev = pending.get(b.tool_use_id);
        if (!ev) continue;
        pending.delete(b.tool_use_id);
        ev.end_ts = ts;
        const tur = r.toolUseResult && typeof r.toolUseResult === 'object' ? r.toolUseResult : null;
        ev.interrupted = !!(tur && tur.interrupted) || /^\[Request interrupted by user/.test(text);
        ev.timed_out = /^Command timed out after/.test(text);
        if (ev.timed_out || ev.interrupted) ev.exit = null;
        else if (b.is_error) ev.exit = exitOf(text);
        else ev.exit = 0;
        ev.output = b.is_error && ev.exit != null ? text.replace(/^(?:Error: )?Exit code \d+\n?/, '') : text;
      }
    }
  }
  shareGrowth(calls, results);
  return { events, cwd, usage: calls.length > 0 };
}
