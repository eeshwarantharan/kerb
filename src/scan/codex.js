// OpenAI Codex CLI rollouts (KERB-V2 10.1). VERIFY 2026-10-01 against the Codex source
// (codex-rs/protocol/src/models.rs, codex-rs/rollout/src/policy.rs): sessions are JSONL files in
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl (CODEX_HOME defaults to ~/.codex), each line
// { timestamp, type, payload }:
//   session_meta  payload { id, cwd, … }
//   response_item payload { type: "function_call", name, arguments (JSON string), call_id }
//                 payload { type: "local_shell_call", call_id, action { command [], working_directory } }
//                 payload { type: "custom_tool_call", name: "apply_patch", call_id, input }
//                 payload { type: "function_call_output" | "custom_tool_call_output", call_id, output }
//   event_msg     payload { type: "token_count", info { last_token_usage { input_tokens,
//                 cached_input_tokens, output_tokens, reasoning_output_tokens } } }
//                 payload { type: "turn_aborted" }
// Shell output text differs across versions: a JSON string {output, metadata {exit_code,
// duration_seconds}}, or text with "Exit code: N" / "Process exited with code N", "Wall time: S
// seconds" and "Output:". Compressed rollouts (.jsonl.zst) are read when this Node has zstd.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { within, tsOf, filesIn, shareGrowth, partsText } from './common.js';

export const AGENT = 'codex';
export const NAME = 'Codex';
const SHELL_FUNCS = new Set(['shell', 'shell_command', 'exec_command', 'container.exec', 'local_shell']);
const EDIT_FUNCS = new Set(['apply_patch', 'write_file', 'edit_file']);

export function baseDir(env = process.env, home = os.homedir()) {
  return env.CODEX_HOME || path.join(home, '.codex');
}

export function sessionFiles(root, { env = process.env, home = os.homedir(), sinceTs = 0 } = {}) {
  const dir = path.join(baseDir(env, home), 'sessions');
  return filesIn(dir, { ext: ['.jsonl', '.jsonl.zst'], recursive: true, sinceTs })
    .filter((f) => path.basename(f.path).startsWith('rollout-'))
    .map((f) => ({ ...f, session: path.basename(f.path).replace(/\.jsonl(\.zst)?$/, '') }));
}

function readLines(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') return { unsupported: true };
    try { buf = zlib.zstdDecompressSync(buf); } catch { return null; }
  }
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function argsOf(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return {}; }
}

/** A shell command from Codex's argv forms: ["bash", "-lc", script] or plain argv. */
function commandText(cmd) {
  if (typeof cmd === 'string') return cmd;
  if (!Array.isArray(cmd) || !cmd.length) return null;
  const i = cmd.findIndex((a) => a === '-lc' || a === '-c');
  if (i !== -1 && /(^|\/)(ba|z)?sh$/.test(cmd[0]) && typeof cmd[i + 1] === 'string') return cmd[i + 1];
  return cmd.join(' ');
}

/** Exit code, duration and output from a shell function's output. */
export function parseShellOutput(raw) {
  const text = partsText(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.content ?? raw : raw);
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && 'output' in j) {
      const md = j.metadata || {};
      return { exit: Number.isInteger(md.exit_code) ? md.exit_code : null, durationMs: Number.isFinite(md.duration_seconds) ? md.duration_seconds * 1000 : null, output: String(j.output ?? '') };
    }
  } catch { /* text form */ }
  const ex = /(?:^|\n)(?:Exit code:|Process exited with code) (\d+)/.exec(text);
  const wall = /(?:^|\n)Wall time: ([\d.]+) seconds/.exec(text);
  const body = /(?:^|\n)Output:\n([\s\S]*)$/.exec(text);
  return { exit: ex ? Number(ex[1]) : null, durationMs: wall ? Number(wall[1]) * 1000 : null, output: body ? body[1] : text };
}

export function readSession(file, root) {
  const recs = readLines(file);
  if (!recs) return { skipped: 'unreadable' };
  if (recs.unsupported) return { skipped: 'compressed (.zst) and this Node has no zstd; Node 22.15 or later reads it' };
  const meta = recs.find((r) => r && r.type === 'session_meta' && r.payload);
  const items = recs.filter((r) => r && (r.type === 'response_item' || r.type === 'event_msg') && r.payload);
  if (!meta && !items.length) return { skipped: 'unrecognised format' };
  const cwd = meta && typeof meta.payload.cwd === 'string' ? meta.payload.cwd : null;
  if (!cwd || !within(root, cwd)) return { skipped: 'outside this repo' };

  const events = [];
  const pending = new Map();
  const calls = [];
  const results = [];
  for (const r of items) {
    const ts = tsOf(r.timestamp);
    const p = r.payload;
    if (r.type === 'event_msg') {
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage;
        calls.push({ inTokens: u.input_tokens || 0, outTokens: Math.max(0, (u.output_tokens || 0) - (u.reasoning_output_tokens || 0)) });
      } else if (p.type === 'turn_aborted') {
        for (const ev of pending.values()) { ev.interrupted = true; ev.end_ts = ts; }
        pending.clear();
      }
      continue;
    }
    // The tool calls of a model call come before its token_count, so this call's index is calls.length.
    if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
      const name = p.type === 'local_shell_call' ? 'local_shell' : p.name;
      if (SHELL_FUNCS.has(name)) {
        const a = p.type === 'local_shell_call' ? (p.action || {}) : argsOf(p.arguments);
        const command = commandText(a.command ?? a.cmd);
        if (!command) continue;
        if (/^apply_patch\b/.test(command.trim())) { events.push({ kind: 'edit', ts, tool: 'apply_patch' }); continue; }
        const ev = { kind: 'shell', id: p.call_id, ts, end_ts: null, command, cwd: a.workdir || a.working_directory || cwd, exit: null, output: '', interrupted: false, timed_out: false, background: false, tokens: null, call: calls.length };
        pending.set(p.call_id, ev);
        events.push(ev);
      } else if (EDIT_FUNCS.has(name)) {
        events.push({ kind: 'edit', ts, tool: name });
      } else events.push({ kind: 'tool', ts, tool: name });
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const ev = pending.get(p.call_id);
      if (!ev) continue;
      pending.delete(p.call_id);
      const o = parseShellOutput(p.output);
      ev.end_ts = o.durationMs != null && ev.ts != null ? ev.ts + o.durationMs : ts;
      ev.output = o.output;
      ev.exit = o.exit;
      ev.timed_out = /\btimed out\b/i.test(o.output.slice(0, 300)) && (o.exit === null || o.exit === 124);
      if (ev.timed_out) ev.exit = null;
      results.push({ call: ev.call, bytes: Buffer.byteLength(o.output), set: (t) => { ev.tokens = t; } });
    }
  }
  shareGrowth(calls, results);
  for (const ev of events) delete ev.call;
  return { events, cwd, usage: calls.length > 0 };
}
