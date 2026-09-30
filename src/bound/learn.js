// Learning boundaries from real policy denials (4.8.5).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWrite, homeKerbDir } from '../util/fsx.js';
import { Store } from '../store/jsonl.js';
import { NETWORK_PROGRAMS } from '../parse/hosts.js';
import { hostMatches } from './precheck.js';

export const LIFETIME_MS = 14 * 86_400_000;
const MAX_LINE = 4096;

/** Programs that make a command network-capable for learning (4.8.5 rule 1). */
export const LEARN_PROGRAMS = new Set(['curl', 'wget', 'npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'uv', 'poetry', 'go', 'cargo',
  'git', 'gh', 'docker', 'podman', 'apt', 'apt-get', 'brew', 'gem', 'bundle', 'mvn', 'gradle', 'dotnet', 'composer']);

const STRONG = [
  (l) => /blocked by (network )?policy/i.test(l),
  (l) => /not permitted by policy/i.test(l),
  (l) => /policy_denied/i.test(l),
  (l) => /denied by (organization |organisation |enterprise |egress )?policy/i.test(l),
  (l) => /firewall/i.test(l) && /block/i.test(l),
  (l) => /CONNECT tunnel failed, response 403/i.test(l),
  (l) => /\b403\b/.test(l) && /proxy/i.test(l),
];
const WEAK = [
  /ENOTFOUND\s+([A-Za-z0-9.-]+)/,
  /getaddrinfo EAI_AGAIN\s+([A-Za-z0-9.-]+)/,
  /Could not resolve host:?\s*([A-Za-z0-9.-]+)/i,
];
const PREFILTER = /policy|firewall|403|ENOTFOUND|EAI_AGAIN|resolve host/i;

/** Collects candidate signature lines while output streams. */
export class DenialScanner {
  constructor() { this.candidates = []; }

  line(l) {
    if (this.candidates.length >= 50 || l.length > MAX_LINE || !PREFILTER.test(l)) return;
    if (STRONG.some((f) => f(l))) { this.candidates.push({ line: l, strength: 'strong' }); return; }
    for (const re of WEAK) {
      const m = re.exec(l);
      if (m) { this.candidates.push({ line: l, strength: 'weak', host: m[1].toLowerCase().replace(/\.$/, '') }); return; }
    }
  }

  /**
   * Resolve against the hosts the command contacted. Returns the denial or null.
   * @param {string[]} hosts extracted and implicit hosts of the command
   * @param {boolean} networkCapable
   */
  resolve(hosts, networkCapable) {
    if (!networkCapable || !hosts.length) return null;
    const lower = [...new Set(hosts.map((h) => h.toLowerCase()))];
    for (const c of this.candidates) {
      if (c.strength === 'weak') {
        if (lower.includes(c.host)) return { host: c.host, strength: 'weak', line: c.line };
        continue;
      }
      const named = lower.find((h) => lineNamesHost(c.line, h));
      if (named) return { host: named, strength: 'strong', line: c.line };
    }
    return null;
  }
}

function lineNamesHost(line, host) {
  const esc = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.-])${esc}($|[^A-Za-z0-9-])`, 'i').test(line);
}

/** Rule 1: at least one segment with hosts, or a network program. */
export function isNetworkCapable(parsed, hosts) {
  return hosts.length > 0 || parsed.segments.some((s) => s.name && LEARN_PROGRAMS.has(s.name));
}

function learnedFile() {
  return path.join(homeKerbDir(), 'learned.jsonl');
}

function readAll() {
  let text = '';
  try { text = fs.readFileSync(learnedFile(), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip damaged line */ }
  }
  return out;
}

function writeAll(entries) {
  atomicWrite(learnedFile(), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
}

/** Entries not yet expired (14 days after their last hit). */
export function loadLearned(nowTs) {
  return readAll().filter((e) => e && e.pattern && nowTs - (e.last_seen || 0) < LIFETIME_MS);
}

function homeStore() {
  return new Store(os.homedir());
}

/**
 * Record a denial. Strong → confirmed. Weak → suspected, confirmed after 2 hits from different keys.
 * @returns {{ entry: any, becameConfirmed: boolean }}
 */
export function recordDenial({ host, strength, key, runId, nowTs }) {
  let result;
  homeStore().withLock(() => {
    const all = readAll().filter((e) => nowTs - (e.last_seen || 0) < LIFETIME_MS);
    let e = all.find((x) => x.kind === 'host' && x.pattern === host);
    let becameConfirmed = false;
    if (!e) {
      e = { kind: 'host', pattern: host, status: strength === 'strong' ? 'confirmed' : 'suspected', first_seen: nowTs, last_seen: nowTs, hits: 1, keys: [key], evidence_run: runId };
      all.push(e);
      becameConfirmed = e.status === 'confirmed';
    } else {
      e.hits = (e.hits || 0) + 1;
      e.last_seen = nowTs;
      if (!e.keys.includes(key)) e.keys = [...e.keys, key].slice(-20);
      if (e.status !== 'confirmed' && (strength === 'strong' || e.keys.length >= 2)) {
        e.status = 'confirmed';
        e.evidence_run = runId;
        becameConfirmed = true;
      }
    }
    writeAll(all);
    result = { entry: { ...e }, becameConfirmed };
  });
  return result;
}

/** Remove learned entries matching a pattern (exact pattern or host glob). Returns removed entries. */
export function forgetLearned(pattern) {
  let removed = [];
  homeStore().withLock(() => {
    const all = readAll();
    const keep = [];
    for (const e of all) {
      if (e.pattern === pattern || hostMatches(pattern, e.pattern)) removed.push(e);
      else keep.push(e);
    }
    if (removed.length) writeAll(keep);
  });
  return removed;
}

/** The learned layer for policy merging: confirmed entries only. */
export function learnedLayer(nowTs) {
  const entries = loadLearned(nowTs);
  const confirmed = entries.filter((e) => e.status === 'confirmed');
  const suspected = entries.filter((e) => e.status !== 'confirmed');
  const layer = confirmed.length ? {
    name: /** @type {const} */ ('learned'),
    source: 'learned from a policy denial',
    policy: {
      boundaries: confirmed.map((e) => ({
        kind: 'host',
        pattern: e.pattern,
        why: `seen ${e.hits} time${e.hits === 1 ? '' : 's'}, last ${new Date(e.last_seen).toISOString().slice(0, 10)} (run ${e.evidence_run})`,
        status: 'confirmed',
        entry: e,
      })),
    },
  } : null;
  return { layer, suspected, entries };
}
