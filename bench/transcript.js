// Per-run metrics from an agent transcript (KERB-V2 15): attempts, tokens and time to green.
// Arm-neutral: the same reading applies to the plain agent and to every Kerb arm.
//
// Claude Code transcripts (format recorded in src/scan/claude.js): assistant records carry
// message.usage (one model call per message id) and Bash tool_use blocks; user records carry the
// tool_result. "Green" is the first run of the task's check command that succeeded: a Bash result
// without an error, or a Kerb cached answer that says the recorded result passed.
import fs from 'node:fs';

/** Records of a JSONL transcript ([] when unreadable). */
export function readTranscript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
  }
  return out;
}

const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('') : '');
const tsOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? t : null; };

/**
 * @param {any[]} recs transcript records
 * @param {RegExp} isCheck matches the task's check command (with or without `kerb run --`)
 * @returns {{ calls: number, tokens: number, attempts: number, green: boolean, attempts_to_green: number | null,
 *   tokens_to_green: number | null, ms_to_green: number | null, total_ms: number | null, compactions: number }}
 */
export function greenMetrics(recs, isCheck) {
  const seen = new Set();
  let tokens = 0;
  let calls = 0;
  let attempts = 0;
  let firstTs = null;
  let lastTs = null;
  let compactions = 0;
  const pending = new Map(); // tool_use id → { tokensSoFar }
  let green = null;
  for (const r of recs) {
    if (!r || typeof r !== 'object') continue;
    const ts = tsOf(r.timestamp);
    if (ts != null) { firstTs = firstTs ?? ts; lastTs = ts; }
    if (r.type === 'system' && /compact/i.test(String(r.subtype || r.content || ''))) compactions++;
    if (r.isCompactSummary) compactions++;
    if (!r.message || r.isSidechain) continue;
    const content = Array.isArray(r.message.content) ? r.message.content : [];
    if (r.type === 'assistant') {
      const u = r.message.usage;
      const id = r.message.id || r.uuid;
      if (u && id && !seen.has(id)) {
        seen.add(id);
        calls++;
        tokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      }
      for (const b of content) {
        if (b && b.type === 'tool_use' && b.name === 'Bash' && b.input && typeof b.input.command === 'string' && isCheck.test(b.input.command)) {
          attempts++;
          pending.set(b.id, { attempts, tokens });
        }
      }
    } else if (r.type === 'user') {
      for (const b of content) {
        if (!b || b.type !== 'tool_result' || !pending.has(b.tool_use_id)) continue;
        const p = pending.get(b.tool_use_id);
        pending.delete(b.tool_use_id);
        const text = textOf(b.content);
        const passed = !b.is_error || /^kerb: cached\b[\s\S]*result: passed/m.test(text);
        if (passed && !green) green = { attempts: p.attempts, tokens: p.tokens, ts };
      }
    }
  }
  return {
    calls, tokens, attempts, compactions,
    green: !!green,
    attempts_to_green: green ? green.attempts : null,
    tokens_to_green: green ? green.tokens : null,
    ms_to_green: green && green.ts != null && firstTs != null ? green.ts - firstTs : null,
    total_ms: firstTs != null && lastTs != null ? lastTs - firstTs : null,
  };
}

/** A regex for a check command, matching it alone or behind `kerb run [opts] --`. */
export function checkPattern(cmd) {
  const esc = cmd.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[;&|]\\s*|\\s--\\s+|\\s)${esc}(\\s|$|;|&|\\|)`);
}
