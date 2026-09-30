// Helpers shared by the agent adapters: tool-name sets, text extraction, exit-code parsing.
import path from 'node:path';
import { formatRefusal } from '../ui/format.js';

/** Shell-running tool names across agents (Claude, Codex, Copilot CLI/VS Code, Cursor, Gemini, OpenCode). */
export const SHELL_TOOLS = new Set([
  'Bash', 'bash', 'Shell', 'shell', 'run_in_terminal', 'runInTerminal', 'run_shell_command', 'powershell', 'local_shell', 'exec_command',
]);

/** A value that may be a string, an object with text fields, or an array of parts → text. */
export function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    for (const k of ['text_result_for_llm', 'textResultForLlm', 'llmContent', 'output', 'text', 'content', 'result']) {
      if (k in v) {
        const t = toText(v[k]);
        if (t) return t;
      }
    }
    const parts = [v.stdout, v.stderr].filter((x) => typeof x === 'string' && x);
    if (parts.length) return parts.join('\n');
  }
  return '';
}

/** Exit code from agent-formatted tool output, or null when there's none. */
export function exitFromText(text) {
  const t = String(text || '');
  const patterns = [
    /^Exit code:? (\d+)/mi, // Claude ("Exit code N"), Codex ("Exit code: N"), Gemini ("Exit Code: N")
    /<exited with exit code (\d+)>/i, // Copilot CLI
    /Command exited with (?:exit )?code (\d+)/i,
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (m) return Number(m[1]);
  }
  return null;
}

/** An explicit exit code field on an object, or null. */
export function exitField(v) {
  if (!v || typeof v !== 'object') return null;
  for (const k of ['exit_code', 'exitCode', 'exit', 'returnCode', 'code']) {
    if (Number.isInteger(v[k])) return v[k];
  }
  return null;
}

/** Tool arguments may arrive as a JSON string. */
export function argsObject(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return { command: v }; }
  }
  return v && typeof v === 'object' ? v : {};
}

export function commandOf(args) {
  const c = args.command ?? args.cmd;
  if (Array.isArray(c)) return c.join(' ');
  return typeof c === 'string' ? c : null;
}

export function resolveCwd(base, dir) {
  if (!dir || typeof dir !== 'string') return base;
  return path.resolve(base, dir);
}

export function refusalText(refusal) {
  return formatRefusal(refusal, false).trimEnd();
}

export function noteLines(notes = [], hints = []) {
  return [...notes.map((n) => `kerb: note · ${n}`), ...hints.map((h) => `kerb: hint · ${h}`)];
}
