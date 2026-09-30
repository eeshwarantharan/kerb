// OpenAI Codex CLI adapter. Verified 2026-10-01 (https://developers.openai.com/codex/hooks):
// Claude-style hooks.json; PreToolUse/PostToolUse with tool_name "Bash", tool_use_id,
// tool_input.command, tool_response; deny via hookSpecificOutput.permissionDecision "deny";
// PostToolUse also runs after non-zero exits; Stop and SessionStart accept systemMessage /
// additionalContext. Hooks are on by default but must be trusted once in /hooks.
import { observePre, callId } from './observe.js';
import { SHELL_TOOLS, toText, exitFromText, exitField, commandOf, refusalText, noteLines } from './shared.js';

export const AGENT = 'codex';

export async function pre(ctx, p) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const command = commandOf(p.tool_input || {});
  if (!command) return null;
  const cwd = p.cwd || ctx.cwd;
  const r = await observePre(ctx, { agent: AGENT, command, cwd, toolUseId: callId(p.tool_use_id, p.session_id, cwd, command), session: p.session_id || null, agentTimeoutMs: Number(p.tool_input && p.tool_input.timeout_ms) || null });
  if (r.refusal) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusalText(r.refusal) } };
  const lines = noteLines(r.notes);
  return lines.length ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: lines.join('\n') } } : null;
}

export async function post(ctx, p) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const command = commandOf(p.tool_input || {});
  if (!command) return null;
  const cwd = p.cwd || ctx.cwd;
  const resp = p.tool_response;
  const text = toText(resp);
  const explicit = exitField(resp);
  const exit = explicit !== null ? explicit : exitFromText(text);
  const { observePost } = await import('./observe-post.js');
  const r = observePost(ctx, { agent: AGENT, toolUseId: callId(p.tool_use_id, p.session_id, cwd, command), cwd, command, exit, output: text, session: p.session_id || null, timedOut: /timed out/i.test(text) && exit === null });
  const lines = noteLines(r.notes, r.hints);
  return lines.length ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } } : null;
}

export function startOutput(lines) {
  return lines.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `Kerb is active in this repo. Known boundaries:\n${lines.join('\n')}` } } : null;
}

export function stopOutput(text) {
  return { systemMessage: text };
}
