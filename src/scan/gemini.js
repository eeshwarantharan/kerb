// Gemini CLI sessions (KERB-V2 10.1). VERIFY 2026-10-01 against the Gemini CLI source
// (packages/core/src/services/chatRecordingService.ts, chatRecordingTypes.ts,
// packages/core/src/config/storage.ts, projectRegistry.ts) and
// https://geminicli.com/docs/cli/session-management/: sessions live in
// ~/.gemini/tmp/<project id>/chats/session-*.jsonl (older versions: session-*.json, one object).
// The project id is a slug kept in a registry, and the directory holds a `.project_root` file
// with the project path; older layouts used sha256(project root) as the directory name. JSONL
// lines are metadata ({ sessionId, projectHash, … }), `{ $set }` updates, `{ $rewindTo: id }`, and
// messages { id, timestamp, type: "user" | "gemini", toolCalls: [{ id, name, args, result,
// status, timestamp }], tokens { input, output, cached, thoughts, tool, total } }.
// The shell tool is run_shell_command; its output text carries "Exit Code: N".
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { crypto } from '../util/lazy.js';
import { within, tsOf, filesIn, partsText, shareGrowth } from './common.js';

export const AGENT = 'gemini';
export const NAME = 'Gemini CLI';
const EDIT_TOOLS = new Set(['replace', 'write_file', 'edit', 'smart_edit']);

export function baseDir(env = process.env, home = os.homedir()) {
  return path.join(home, '.gemini');
}

/** Project temp directories that belong to the repo (or a directory inside it). */
function projectDirs(root, home, env) {
  const tmp = path.join(baseDir(env, home), 'tmp');
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return []; }
  const legacy = crypto().createHash('sha256').update(root).digest('hex');
  const out = [];
  for (const n of names) {
    const dir = path.join(tmp, n);
    let owner = null;
    try { owner = fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim(); } catch { /* none */ }
    if ((owner && within(root, owner)) || n === legacy) out.push(dir);
  }
  return out;
}

export function sessionFiles(root, { env = process.env, home = os.homedir(), sinceTs = 0 } = {}) {
  const out = [];
  for (const dir of projectDirs(root, home, env)) {
    for (const f of filesIn(path.join(dir, 'chats'), { ext: ['.jsonl', '.json'], sinceTs, recursive: true })) {
      out.push({ ...f, session: path.basename(f.path).replace(/\.jsonl?$/, '') });
    }
  }
  return out;
}

function readMessages(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (file.endsWith('.json')) {
    try {
      const j = JSON.parse(text);
      return Array.isArray(j.messages) ? j.messages : null;
    } catch { return null; }
  }
  let messages = [];
  let seen = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (typeof r.$rewindTo === 'string') {
      const i = messages.findIndex((m) => m.id === r.$rewindTo);
      if (i !== -1) messages = messages.slice(0, i);
      seen = true;
    } else if (r.$set || r.sessionId || r.projectHash) seen = true;
    else if (r.type && r.id) {
      seen = true;
      const i = messages.findIndex((m) => m.id === r.id);
      if (i === -1) messages.push(r);
      else messages[i] = { ...messages[i], ...r };
    }
  }
  return seen ? messages : null;
}

function resultText(result) {
  if (!Array.isArray(result)) return partsText(result);
  return result.map((p) => {
    const resp = p && p.functionResponse && p.functionResponse.response;
    if (resp) return typeof resp.output === 'string' ? resp.output : typeof resp.error === 'string' ? resp.error : JSON.stringify(resp);
    return partsText(p);
  }).join('\n');
}

export function readSession(file, root) {
  const messages = readMessages(file);
  if (!messages) return { skipped: 'unrecognised format' };
  const events = [];
  const calls = [];
  const results = [];
  for (const m of messages) {
    if (m.type !== 'gemini') continue;
    const ci = m.tokens && Number.isFinite(m.tokens.input) ? calls.length : null;
    if (ci != null) calls.push({ inTokens: m.tokens.input, outTokens: (m.tokens.output || 0) });
    for (const tc of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const ts = tsOf(tc.timestamp) ?? tsOf(m.timestamp);
      if (tc.name === 'run_shell_command' && tc.args && typeof tc.args.command === 'string') {
        const text = resultText(tc.result);
        const ex = /(?:^|\n)Exit Code: (\d+)/.exec(text);
        const out = /(?:^|\n)Output: ?([\s\S]*?)(?:\nError: |\nExit Code: |\nSignal: |\nBackground PIDs: |$)/.exec(text);
        const cancelled = tc.status === 'cancelled';
        const ev = {
          kind: 'shell', id: tc.id, ts, end_ts: null, command: tc.args.command, cwd: tc.args.directory ? path.resolve(root, tc.args.directory) : root,
          exit: cancelled ? null : ex ? Number(ex[1]) : tc.status === 'success' ? 0 : null,
          output: out ? out[1] : text, interrupted: cancelled, timed_out: /timed out/i.test(text.slice(0, 300)) && !ex, background: !!tc.args.is_background, tokens: null,
        };
        events.push(ev);
        if (ci != null) results.push({ call: ci, bytes: Buffer.byteLength(ev.output), set: (t) => { ev.tokens = t; } });
      } else if (EDIT_TOOLS.has(tc.name)) events.push({ kind: 'edit', ts, tool: tc.name });
      else events.push({ kind: 'tool', ts, tool: tc.name });
    }
  }
  shareGrowth(calls, results);
  return { events, cwd: root, usage: calls.length > 0 };
}
