// Cursor adapter. Verified 2026-10-01 (https://cursor.com/docs/hooks):
// .cursor/hooks.json { version: 1, hooks: { preToolUse: [{ command, matcher: "Shell" }] … } }.
// preToolUse input: { tool_name: "Shell", tool_input: { command, working_directory }, tool_use_id, cwd, conversation_id };
// deny: { permission: "deny", user_message, agent_message }. Allowing is done by printing nothing:
// "no output" is a hook failure, which fails open by default, so Kerb never answers "allow".
// postToolUse: tool_output is a JSON string with exitCode/stdout; postToolUseFailure: error_message,
// failure_type ("error" | "timeout" | "permission_denied"), is_interrupt. stop has no user-visible
// channel (followup_message would be sent as a user message), so there is no recap in Cursor.
import { observePre, callId } from './observe.js';
import { SHELL_TOOLS, toText, exitFromText, exitField, argsObject, commandOf, resolveCwd, refusalText, noteLines } from './shared.js';

export const AGENT = 'cursor';

function base(ctx, p) {
  const args = argsObject(p.tool_input);
  const command = commandOf(args);
  const root = p.cwd || (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || ctx.cwd;
  const cwd = resolveCwd(root, args.working_directory);
  const session = p.conversation_id || p.session_id || null;
  return { args, command, cwd, session, id: callId(p.tool_use_id, session, cwd, command || '') };
}

export async function pre(ctx, p) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const b = base(ctx, p);
  if (!b.command) return null;
  const r = await observePre(ctx, { agent: AGENT, command: b.command, cwd: b.cwd, background: !!b.args.is_background, toolUseId: b.id, session: b.session });
  if (!r.refusal) return null;
  const text = refusalText(r.refusal);
  return { permission: 'deny', user_message: text.split('\n')[0], agent_message: text };
}

export async function post(ctx, p, { failure = false } = {}) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const b = base(ctx, p);
  if (!b.command) return null;
  let exit = null;
  let text = '';
  let timedOut = false;
  let interrupted = false;
  if (failure || p.failure_type) {
    if (p.failure_type === 'permission_denied') return null;
    text = String(p.error_message || '');
    exit = exitFromText(text);
    timedOut = p.failure_type === 'timeout';
    interrupted = !!p.is_interrupt;
  } else {
    const out = argsObject(p.tool_output);
    text = toText(out);
    const explicit = exitField(out);
    exit = explicit !== null ? explicit : exitFromText(text);
  }
  const { observePost } = await import('./observe-post.js');
  const r = observePost(ctx, { agent: AGENT, toolUseId: b.id, cwd: b.cwd, command: b.command, exit, output: text, durationMs: Number.isFinite(p.duration) ? p.duration : null, timedOut, interrupted, session: b.session });
  const lines = noteLines(r.notes, r.hints);
  return lines.length ? { additional_context: lines.join('\n') } : null;
}

export function startOutput(lines) {
  return lines.length ? { additional_context: `Kerb is active in this repo. Known boundaries:\n${lines.join('\n')}` } : null;
}

export function stopOutput() {
  return null;
}
