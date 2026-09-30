// Team review of learned denials (4.8.5): export (no command text, no output) and aggregate
// into a proposed policy patch plus a Markdown summary for the admin.
import fs from 'node:fs';
import os from 'node:os';
import { sha256 } from '../util/core.js';
import { loadLearned } from './learn.js';
import { hostMatches } from './precheck.js';

export const MIN_MACHINES = 3;

/** A stable pseudonymous id for this machine and user (no hostname or username leaves). */
export function machineId() {
  return sha256(`${os.hostname()}\0${os.homedir()}`).slice(0, 16);
}

/** Learned entries seen since `fromTs`, stripped to what a reviewer needs. */
export function exportDenials(fromTs, nowTs) {
  const machine = machineId();
  return loadLearned(nowTs)
    .filter((e) => (e.last_seen || 0) >= fromTs)
    .map((e) => ({
      kind: e.kind || 'host',
      pattern: e.pattern,
      status: e.status,
      hits: e.hits || 1,
      distinct_commands: Array.isArray(e.keys) ? e.keys.length : 1,
      first_seen: e.first_seen,
      last_seen: e.last_seen,
      machine,
    }));
}

/** Parse exported files (JSONL, or a JSON object with `entries`). */
export function readExports(files) {
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').trim();
    if (!text) continue;
    if (text.startsWith('{') && text.includes('"entries"') && !text.includes('\n{')) {
      try { out.push(...(JSON.parse(text).entries || [])); continue; } catch { /* fall back to lines */ }
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  }
  return out.filter((e) => e && typeof e.pattern === 'string' && e.pattern);
}

/**
 * Aggregate exports. Hosts seen on MIN_MACHINES or more machines become candidates.
 * Hosts a current policy boundary already covers are listed as such and never proposed:
 * review never loosens or rewrites a block from a higher layer.
 * @param {any[]} entries
 * @param {{ boundaries: any[] }} policy the merged policy in effect
 */
export function reviewDenials(entries, policy, minMachines = MIN_MACHINES) {
  const byPattern = new Map();
  for (const e of entries) {
    const k = e.pattern.toLowerCase();
    const a = byPattern.get(k) || { pattern: k, machines: new Set(), hits: 0, confirmed: 0, suspected: 0, first_seen: Infinity, last_seen: 0 };
    a.machines.add(e.machine || 'unknown');
    a.hits += e.hits || 1;
    if (e.status === 'confirmed') a.confirmed++;
    else a.suspected++;
    a.first_seen = Math.min(a.first_seen, e.first_seen || Infinity);
    a.last_seen = Math.max(a.last_seen, e.last_seen || 0);
    byPattern.set(k, a);
  }
  const candidates = [];
  const alreadyBlocked = [];
  const belowThreshold = [];
  for (const a of byPattern.values()) {
    const row = { pattern: a.pattern, machines: a.machines.size, hits: a.hits, confirmed: a.confirmed, suspected: a.suspected, first_seen: a.first_seen, last_seen: a.last_seen };
    const covered = (policy.boundaries || []).find((b) => b.kind === 'host' && b.layer !== 'learned' && hostMatches(b.pattern, a.pattern));
    if (covered) alreadyBlocked.push({ ...row, by: covered.source, boundary: covered.pattern });
    else if (a.machines.size >= minMachines) candidates.push(row);
    else belowThreshold.push(row);
  }
  candidates.sort((x, y) => y.machines - x.machines || y.hits - x.hits);
  const patch = {
    version: 1,
    boundaries: candidates.map((c) => ({
      kind: 'host',
      pattern: c.pattern,
      why: `TODO: confirm why ${c.pattern} is blocked (seen on ${c.machines} machines), or delete this entry and open it in the firewall`,
    })),
  };
  return { candidates, alreadyBlocked, belowThreshold, patch };
}

export function reviewMarkdown(r, { sources, minMachines = MIN_MACHINES }) {
  const date = (t) => (Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : '?');
  const lines = [
    '# Kerb denial review',
    '',
    `Built from ${sources} export file${sources === 1 ? '' : 's'}. Hosts that agents hit a policy wall on, seen on ${minMachines} or more machines, are proposed below.`,
    '',
  ];
  if (!r.candidates.length) lines.push('No host reached the threshold.', '');
  for (const c of r.candidates) {
    lines.push(
      `## ${c.pattern}`,
      '',
      `Seen on ${c.machines} machines, ${c.hits} hits (${c.confirmed} confirmed, ${c.suspected} suspected), ${date(c.first_seen)} to ${date(c.last_seen)}.`,
      '',
      'Choose one:',
      '',
      `1. **Open it in the firewall.** Delete the \`${c.pattern}\` entry from \`policy.patch.json\`; developers can run \`kerb forget ${c.pattern}\` to clear their learned copy.`,
      `2. **Add an alternative.** Keep the entry and set \`alternative\` to the approved mirror or service, so agents are told what to use instead.`,
      `3. **Confirm the block.** Keep the entry and replace the \`why\` placeholder with the reason agents should see.`,
      '',
    );
  }
  if (r.alreadyBlocked.length) {
    lines.push('## Already blocked by policy', '', 'These are covered by an existing boundary; the review does not change them.', '');
    for (const a of r.alreadyBlocked) lines.push(`- ${a.pattern}: covered by \`${a.boundary}\` (${a.by}), seen on ${a.machines} machine${a.machines === 1 ? '' : 's'}`);
    lines.push('');
  }
  if (r.belowThreshold.length) {
    lines.push(`## Below the threshold (fewer than ${minMachines} machines)`, '');
    for (const b of r.belowThreshold) lines.push(`- ${b.pattern}: ${b.machines} machine${b.machines === 1 ? '' : 's'}, ${b.hits} hits`);
    lines.push('');
  }
  return lines.join('\n');
}
