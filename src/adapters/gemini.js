// Gemini CLI adapter. Verified 2026-10-01 (https://geminicli.com/docs/hooks/reference):
// settings.json hooks { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type, command, timeout (ms) }] }] }.
// BeforeTool input: { session_id, cwd, tool_name, tool_input: { command, dir_path, is_background } };
// deny: { decision: "deny", reason } (reason goes to the agent). AfterTool: tool_response
// { llmContent, returnDisplay, error } where the shell output carries an "Exit Code: N" line.
// SessionStart accepts hookSpecificOutput.additionalContext; AfterAgent accepts systemMessage.
import { observePre, callId } from './observe.js';
import { SHELL_TOOLS, toText, exitFromText, argsObject, commandOf, resolveCwd, refusalText, noteLines } from './shared.js';

export const AGENT = 'gemini';

/** Drop per-run lines (PIDs, PGIDs) that would make every failure look different. */
export function cleanShellOutput(text) {
  return String(text || '').split('\n').filter((l) => !/^(Process Group PGID|Background PIDs|Directory):/.test(l)).join('\n');
}

export async function pre(ctx, p) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const args = argsObject(p.tool_input);
  const command = commandOf(args);
  if (!command) return null;
  const cwd = resolveCwd(p.cwd || ctx.cwd, args.dir_path || args.directory);
  const r = await observePre(ctx, { agent: AGENT, command, cwd, background: !!args.is_background, toolUseId: callId(null, p.session_id, cwd, command), session: p.session_id || null });
  if (r.refusal) return { decision: 'deny', reason: refusalText(r.refusal) };
  const lines = noteLines(r.notes);
  return lines.length ? { hookSpecificOutput: { additionalContext: lines.join('\n') } } : null;
}

export async function post(ctx, p) {
  if (!SHELL_TOOLS.has(p.tool_name)) return null;
  const args = argsObject(p.tool_input);
  const command = commandOf(args);
  if (!command) return null;
  const cwd = resolveCwd(p.cwd || ctx.cwd, args.dir_path || args.directory);
  const resp = p.tool_response || {};
  const text = toText(resp.llmContent ?? resp.returnDisplay ?? resp);
  const exit = exitFromText(text);
  const { observePost } = await import('./observe-post.js');
  const r = observePost(ctx, { agent: AGENT, toolUseId: callId(null, p.session_id, cwd, command), cwd, command, exit, output: cleanShellOutput(text), session: p.session_id || null });
  const lines = noteLines(r.notes, r.hints);
  return lines.length ? { hookSpecificOutput: { additionalContext: lines.join('\n') } } : null;
}

export function startOutput(lines) {
  return lines.length ? { hookSpecificOutput: { additionalContext: `Kerb is active in this repo. Known boundaries:\n${lines.join('\n')}` } } : null;
}

export function stopOutput(text) {
  return { systemMessage: text };
}
