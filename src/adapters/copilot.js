// GitHub Copilot adapter: Copilot CLI and the VS Code Local agent. Verified 2026-10-01:
//  - https://docs.github.com/en/copilot/reference/hooks-reference (CLI and cloud agent)
//  - https://code.visualstudio.com/docs/agents/reference/hooks-reference (VS Code Local)
// One file, .github/hooks/kerb.json in the Copilot format (version 1, camelCase events), is read by
// both. Payload dialects handled here:
//  - CLI camelCase: { sessionId, cwd, toolName: "bash", toolArgs, toolResult: { resultType, textResultForLlm } | error }
//  - VS Code-compatible snake_case: { session_id, cwd, tool_name, tool_input, tool_result | tool_response, tool_use_id? }
// Deny: permissionDecision "deny" (top-level for the CLI, inside hookSpecificOutput for VS Code).
// A command preToolUse hook that exits non-zero denies the call, so the handler always exits 0.
import { observePre, observePost, callId } from './observe.js';
import { SHELL_TOOLS, toText, exitFromText, exitField, argsObject, commandOf, resolveCwd, refusalText, noteLines } from './shared.js';

export const AGENT = 'copilot';

function norm(p) {
  const args = argsObject(p.tool_input ?? p.toolArgs);
  const cwdBase = p.cwd || null;
  return {
    tool: p.tool_name ?? p.toolName,
    args,
    command: commandOf(args),
    session: p.session_id ?? p.sessionId ?? null,
    id: p.tool_use_id ?? p.toolUseId ?? null,
    cwdBase,
    background: !!(args.isBackground ?? args.is_background ?? args.run_in_background ?? (args.mode === 'async')),
  };
}

export function pre(ctx, p) {
  const n = norm(p);
  if (!SHELL_TOOLS.has(n.tool) || !n.command) return null;
  const cwd = resolveCwd(n.cwdBase || ctx.cwd, n.args.cwd || n.args.directory);
  const r = observePre(ctx, { agent: AGENT, command: n.command, cwd, background: n.background, toolUseId: callId(n.id, n.session, cwd, n.command), session: n.session });
  if (r.refusal) {
    const reason = refusalText(r.refusal);
    return {
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    };
  }
  const lines = noteLines(r.notes);
  return lines.length ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } } : null;
}

export function post(ctx, p, { failure = false } = {}) {
  const n = norm(p);
  if (!SHELL_TOOLS.has(n.tool) || !n.command) return null;
  const cwd = resolveCwd(n.cwdBase || ctx.cwd, n.args.cwd || n.args.directory);
  let text;
  let exit;
  if (failure || typeof p.error === 'string') {
    text = String(p.error || '');
    exit = exitFromText(text);
  } else {
    const res = p.tool_response ?? p.tool_result ?? p.toolResult;
    text = toText(res);
    const explicit = exitField(res);
    exit = explicit !== null ? explicit : exitFromText(text);
  }
  const r = observePost(ctx, { agent: AGENT, toolUseId: callId(n.id, n.session, cwd, n.command), cwd, command: n.command, exit, output: text, session: n.session });
  const lines = noteLines(r.notes, r.hints);
  if (!lines.length) return null;
  return { additionalContext: lines.join('\n'), hookSpecificOutput: { hookEventName: failure ? 'PostToolUseFailure' : 'PostToolUse', additionalContext: lines.join('\n') } };
}

export function startOutput(lines) {
  if (!lines.length) return null;
  const text = `Kerb is active in this repo. Known boundaries:\n${lines.join('\n')}`;
  return { additionalContext: text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

export function stopOutput(text) {
  return { systemMessage: text };
}
