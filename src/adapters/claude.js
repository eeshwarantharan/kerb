// Claude Code adapter (4.10.2), observe mode. Verified against the hooks reference on
// 2026-10-01 (https://code.claude.com/docs/en/hooks):
//   PreToolUse  → tool_input { command, description, timeout (ms), run_in_background }, tool_use_id
//   PostToolUse → tool_response { stdout, stderr, interrupted, isImage } (success; no exit code)
//   PostToolUseFailure → error "Exit code N\n<output>", is_interrupt, duration_ms
//   deny → { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } }
//   Stop → top-level systemMessage is shown to the user; SessionEnd discards JSON output.
import { formatRefusal } from '../ui/format.js';
import { observePre, observePost, callId } from './observe.js';
import { toText, exitFromText, exitField } from './shared.js';

export const AGENT = 'claude';
/** Claude Code's Bash default when the call sets no timeout (BASH_DEFAULT_TIMEOUT_MS; 2 minutes). */
export const DEFAULT_BASH_TIMEOUT_MS = 120_000;

export function agentTimeout(payload, env) {
  const t = payload.tool_input && Number(payload.tool_input.timeout);
  if (Number.isFinite(t) && t > 0) return t;
  const d = Number(env.BASH_DEFAULT_TIMEOUT_MS);
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_BASH_TIMEOUT_MS;
}

/** Deny output: the three-line refusal is the reason Claude sees. */
export function denyOutput(refusal) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: formatRefusal(refusal, false).trimEnd(),
    },
  };
}

function contextOutput(event, lines) {
  if (!lines.length) return null;
  return { hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } };
}

/** @returns {object | null} JSON to print, or null for no output (no decision). */
/**
 * Copilot CLI and VS Code also read .claude/settings files and send their own payload dialect
 * (with a `timestamp`, no `transcript_path`, `tool_result` instead of `tool_response`).
 */
export function agentOf(payload) {
  return payload.timestamp !== undefined && payload.transcript_path === undefined ? 'copilot' : AGENT;
}

export function pre(ctx, payload) {
  if (payload.tool_name && payload.tool_name !== 'Bash') return null;
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string' || !command.trim()) return null;
  const cwd = payload.cwd || ctx.cwd;
  const r = observePre(ctx, {
    agent: agentOf(payload),
    command,
    cwd,
    background: !!(payload.tool_input && payload.tool_input.run_in_background),
    toolUseId: callId(payload.tool_use_id, payload.session_id, cwd, command),
    session: payload.session_id || null,
    agentTimeoutMs: agentTimeout(payload, ctx.env),
  });
  if (r.refusal) return denyOutput(r.refusal);
  return contextOutput('PreToolUse', r.notes.map((n) => `kerb: note · ${n}`));
}

/** Exit code from a PostToolUseFailure `error` string ("Exit code N" first line), or null. */
export function exitFromError(error) {
  const m = /^Exit code (\d+)/.exec(String(error || ''));
  return m ? Number(m[1]) : null;
}

export function post(ctx, payload, { failure = false } = {}) {
  if (payload.tool_name && payload.tool_name !== 'Bash') return null;
  const command = payload.tool_input && payload.tool_input.command;
  if (typeof command !== 'string') return null;
  let exit;
  let output;
  let interrupted = false;
  let timedOut = false;
  if (failure) {
    const err = String(payload.error || '');
    exit = exitFromError(err);
    output = exit === null ? err : err.split('\n').slice(1).join('\n');
    interrupted = !!payload.is_interrupt;
    timedOut = /Command timed out after/.test(err);
  } else if (payload.tool_response === undefined && payload.tool_result !== undefined) {
    // Copilot dialect: the tool result is text; the exit code only appears inside it.
    output = toText(payload.tool_result);
    exit = exitField(payload.tool_result) ?? exitFromText(output);
  } else {
    const resp = payload.tool_response || {};
    output = typeof resp === 'string' ? resp : [resp.stdout, resp.stderr].filter((x) => typeof x === 'string' && x).join('\n');
    interrupted = !!resp.interrupted;
    // PostToolUse fires only for calls that succeeded; an explicit exit code wins if present.
    const explicit = exitField(resp);
    exit = explicit !== null ? explicit : interrupted ? null : 0;
  }
  const cwd = payload.cwd || ctx.cwd;
  const r = observePost(ctx, {
    agent: agentOf(payload),
    toolUseId: callId(payload.tool_use_id, payload.session_id, cwd, command),
    cwd,
    command,
    exit,
    output,
    durationMs: Number.isFinite(payload.duration_ms) ? payload.duration_ms : null,
    interrupted,
    timedOut,
    session: payload.session_id || null,
  });
  const lines = [...r.notes.map((n) => `kerb: note · ${n}`), ...r.hints.map((h) => `kerb: hint · ${h}`)];
  return contextOutput(failure ? 'PostToolUseFailure' : 'PostToolUse', lines);
}

/** SessionStart: tell Claude the known boundaries up front. */
export function startOutput(lines) {
  if (!lines.length) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Kerb is active in this repo. Known boundaries:\n${lines.join('\n')}` } };
}

/** Stop: a top-level systemMessage is shown to the user. */
export function stopOutput(text) {
  return { systemMessage: text };
}
