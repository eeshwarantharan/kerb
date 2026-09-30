// Instructions block (4.10.4), boundaries briefing (4.10.5) and skill (4.10.6).
import fs from 'node:fs';
import path from 'node:path';
import { now } from '../util/core.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { Store } from '../store/jsonl.js';
import { boundaryHits } from '../bound/hits.js';

export const START_MARKER = '<!-- kerb:start -->';
export const END_MARKER = '<!-- kerb:end -->';
export const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
const MAX_LINES = 10;
const MAX_BYTES = 300 * 4;

function describe(b) {
  if (b.kind === 'host') return b.pattern;
  if (b.kind === 'program') return `the ${b.pattern} command`;
  if (b.kind === 'command') return `\`${b.pattern}\``;
  return `pushing to ${b.pattern}`;
}

/** Briefing lines: at most 10 lines and 300 tokens (4 bytes per token), most-hit first. */
export function briefingLines(root) {
  const policy = loadPolicy(root, loadConfig(), now());
  let hits = {};
  try { hits = boundaryHits(new Store(root).read()); } catch { hits = {}; }
  const scored = policy.boundaries.map((b, i) => ({
    b, i, hits: b.layer === 'learned' && b.entry ? b.entry.hits : hits[`${b.kind}:${b.pattern}`] || 0,
  }));
  scored.sort((x, y) => y.hits - x.hits || x.i - y.i);
  const lines = [];
  let bytes = 0;
  for (const { b } of scored) {
    if (lines.length >= MAX_LINES) break;
    const why = (b.layer === 'learned' ? 'blocked here (learned from a policy denial)' : b.why || 'blocked here').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
    let line = `- ${describe(b)}: ${why}${b.alternative ? ` (use ${b.alternative})` : ''}`;
    if (line.length > 160) line = `${line.slice(0, 159)}…`;
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > MAX_BYTES) break;
    lines.push(line);
    bytes += size;
  }
  return lines;
}

export function instructionsBlock(lines) {
  const known = lines.length ? lines.join('\n') : '- none known yet';
  return `${START_MARKER}
## Running commands with Kerb
This repo uses Kerb. When your agent has no Kerb hook, run shell commands as \`kerb run -- <command>\`.
- A line starting \`kerb: policy_blocked\` means the action is not allowed here. Do not retry it or look for a way around it. Use the alternative Kerb names, or tell the user what you need.
- A line starting \`kerb: identical_retry\`, \`kerb: deja_vu\` or \`kerb: breaker_open\` means running it again cannot help. Change the code or the approach first.
- To wait for a service or poll until something passes, use one call: \`kerb wait-for --max 3m -- <command>\`. Don't re-run a command turn after turn.
- Trust the \`kerb:\` line, not the exit code alone.
- Never run \`kerb ack\`, \`kerb reset\`, \`kerb forget\`, \`kerb config\` or \`kerb run --force\`, and never set \`KERB_*\` variables. Those are for the user.
Known boundaries here:
${known}
${END_MARKER}`;
}

export const SKILL = `---
name: kerb
description: Use Kerb for shell commands in repos with kerb.policy.json or a .kerb folder, so blocked actions and useless retries are caught before they waste turns.
---

# Using Kerb

If no Kerb hook is active, run shell commands as \`kerb run -- <command>\`.

## Reading Kerb's answers
- \`kerb: policy_blocked\`: not allowed here. Don't retry or work around it. Use the named alternative, or tell the user what you need and why.
- \`kerb: identical_retry\`: nothing relevant changed since this failed. Change something first. If a service isn't up yet, use \`kerb wait-for\`.
- \`kerb: deja_vu\`: your files are back in a state that already failed. Try a different fix.
- \`kerb: breaker_open\`: the same failure keeps happening despite edits. Stop, summarise what you tried, and propose a different approach.
- Exit 124 or 125 with a Kerb footer: the command hung and was killed. Look for watch modes, prompts or servers; use a non-interactive variant or run servers in the background.

## Waiting and polling
- Use \`kerb wait-for --max 3m -- <command>\` to wait for a database, a server or a deploy. It retries inside one call and returns once.
- \`--until output:<regex>\` waits for specific output; \`--interval\` and \`--backoff\` control pacing.

## Rules
- Trust the \`kerb:\` line, not the exit code alone.
- Never run \`kerb ack\`, \`kerb reset\`, \`kerb forget\`, \`kerb config\` or \`kerb run --force\`, and never set \`KERB_*\` variables.
- Run \`kerb map\` at the start of a task to see known boundaries.
- The footer shows the full log path. Read the log only when the shaped output isn't enough.
`;

/** Replace the marker block in text; returns null if there is no block. */
export function replaceBlock(text, block) {
  const s = text.indexOf(START_MARKER);
  const e = text.indexOf(END_MARKER);
  if (s === -1 || e === -1 || e < s) return null;
  return text.slice(0, s) + block + text.slice(e + END_MARKER.length);
}

/** Rewrite existing marker blocks with the current briefing. Returns files changed. */
export function regenerateBriefing(root) {
  const block = instructionsBlock(briefingLines(root));
  const changed = [];
  for (const rel of INSTRUCTION_FILES) {
    const file = path.join(root, rel);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const next = replaceBlock(text, block);
    if (next !== null && next !== text) {
      fs.writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return changed;
}
