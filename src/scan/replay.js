// Replay (KERB-V2 10.1): what Kerb's default rules would have done with past sessions. Nothing
// runs; every count is an approximation from the transcript, labelled "replayed".
import os from 'node:os';
import path from 'node:path';
import { parseCommand } from '../parse/tokenize.js';
import { classifyCommand } from '../parse/classify-cmd.js';
import { commandHosts } from '../parse/hosts.js';
import { boundaryCheck } from '../bound/precheck.js';
import { DenialScanner, isNetworkCapable } from '../bound/learn.js';
import { analyzeText } from '../loop/fingerprint.js';
import { classifyEnvironment } from '../insight/envclass.js';
import { kerbArgv, kerbSubcommand } from '../bound/human.js';

export const DEFAULT_BUDGET = 12_000;
const COOLDOWN_MS = 60_000;
const POLL_GAP_MS = 5 * 60_000;
const SETUP = new Set(['check', 'other', 'background']);
const KERB_REFUSAL = /^kerb: (identical_retry|deja_vu|breaker_open|policy_blocked|human_only|oscillating|cached) · /m;
const NO_GIT = { resolveGitRemote: () => null, branch: () => null, branches: () => [] };

export function emptyMetrics() {
  return {
    commands: 0,
    identical_retries: { count: 0, run_time_ms: 0, output_bytes: 0, tokens: 0, tokens_measured_for: 0 },
    blocked_host_retries: { count: 0, hosts: [] },
    policy_blocked: { count: 0 },
    environment: { tls_interception: 0, proxy_page: 0, auth_expired: 0 },
    hangs: { count: 0, run_time_ms: 0 },
    noise: { commands: 0, bytes_beyond_budget: 0, tokens: 0, tokens_measured_for: 0 },
    polling: { groups: 0, attempts_folded: 0 },
  };
}

/** The command Kerb would see: the inner command of `kerb run|wait-for … -- <inner>`. */
function innerCommand(parsed, command) {
  if (parsed.segments.length !== 1) return command;
  const argv = kerbArgv(parsed.segments[0]);
  if (!argv) return command;
  const { sub, rest } = kerbSubcommand(argv);
  const dd = rest.indexOf('--');
  if ((sub === 'run' || sub === 'wait-for') && dd !== -1 && rest.length > dd + 1) return rest.slice(dd + 1).join(' ');
  return command;
}

const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
const bytes = (s) => Buffer.byteLength(s || '');
const failed = (e) => e.exit != null && e.exit !== 0 && !e.timed_out && !e.interrupted;
const duration = (e) => (e.ts != null && e.end_ts != null && e.end_ts >= e.ts ? e.end_ts - e.ts : 0);

/**
 * @param {{ agent: string, session: string, events: any[] }[]} sessions
 * @param {{ root: string, policy: any, checkCommands: any[], budget?: number, home?: string }} o
 *   policy: the org and repo layers only (learning is replayed from the transcripts)
 */
export function replay(sessions, o) {
  const m = emptyMetrics();
  const budget = o.budget || DEFAULT_BUDGET;
  const home = o.home || os.homedir();
  const prepared = [];
  for (const s of sessions) {
    for (const e of s.events) {
      if (e.kind !== 'shell') continue;
      if (KERB_REFUSAL.test(e.output || '')) { e.skip = true; continue; } // Kerb already refused it
      const cwd = e.cwd || o.root;
      let parsed = parseCommand(e.command, { cwd, home });
      const inner = innerCommand(parsed, e.command);
      if (inner !== e.command) parsed = parseCommand(inner, { cwd, home });
      e.parsed = parsed;
      e.cls = classifyCommand(parsed, { checkCommands: o.checkCommands, background: !!e.background });
      e.key = `${path.relative(o.root, cwd) || '.'}::${norm(inner)}`;
      prepared.push(e);
    }
  }
  m.commands = prepared.length;

  // Boundaries, learned denials, environment failures, hangs and noise: chronological across
  // sessions, since learned walls outlive a session.
  const confirmed = new Set();
  const weakKeys = new Map();
  for (const e of [...prepared].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) {
    const hosts = [...new Set(commandHosts(e.parsed, { env: {}, home, ...NO_GIT }).map((h) => h.host.toLowerCase()))];
    const pre = boundaryCheck(e.parsed, o.policy, { env: {}, home, ...NO_GIT });
    if (pre.refusal) m.policy_blocked.count++;
    else {
      const wall = hosts.find((h) => confirmed.has(h));
      if (wall) {
        m.blocked_host_retries.count++;
        if (!m.blocked_host_retries.hosts.includes(wall)) m.blocked_host_retries.hosts.push(wall);
      }
    }
    if (failed(e)) {
      const scan = new DenialScanner();
      for (const l of e.output.split('\n')) scan.line(l);
      const d = scan.resolve(hosts, isNetworkCapable(e.parsed, hosts));
      if (d && d.strength === 'strong') confirmed.add(d.host);
      else if (d) {
        const keys = weakKeys.get(d.host) || new Set();
        keys.add(e.key);
        weakKeys.set(d.host, keys);
        if (keys.size >= 2) confirmed.add(d.host);
      }
      const env = classifyEnvironment(e.output);
      if (env) m.environment[env.subtype]++;
    }
    if (e.timed_out || e.interrupted) {
      m.hangs.count++;
      m.hangs.run_time_ms += duration(e);
    }
    const size = bytes(e.output);
    if (size > budget) {
      m.noise.commands++;
      m.noise.bytes_beyond_budget += size - budget;
      if (e.tokens != null) {
        m.noise.tokens += Math.round((e.tokens * (size - budget)) / size);
        m.noise.tokens_measured_for++;
      }
    }
  }

  // Identical retries and polling: within a session.
  for (const s of sessions) {
    const last = new Map();
    let epoch = 0;
    const run = [];
    const flushPolls = () => {
      if (run.length >= 3) {
        const folded = run.slice(1).filter((e) => !e.counted).length;
        if (folded > 0) { m.polling.groups++; m.polling.attempts_folded += folded; }
      }
      run.length = 0;
    };
    for (const e of s.events) {
      if (e.kind === 'edit') { epoch++; flushPolls(); continue; }
      if (e.kind !== 'shell' || e.skip || !e.parsed) { if (e.kind !== 'shell') flushPolls(); continue; }
      const prev = last.get(e.key);
      if (e.cls === 'check' && prev && failed(prev.ev) && prev.epoch === epoch) {
        const kind = analyzeText(prev.ev.output || '').kind;
        let count = false;
        if (kind === 'ordinary') count = true;
        else if (kind === 'transient') { count = !!prev.ev.transientRetry; e.transientRetry = true; }
        else if (kind === 'dependency') count = prev.ev.end_ts != null && e.ts != null && e.ts - prev.ev.end_ts < COOLDOWN_MS;
        if (count) {
          e.counted = true;
          const r = m.identical_retries;
          r.count++;
          r.run_time_ms += duration(e);
          r.output_bytes += bytes(e.output);
          if (e.tokens != null) { r.tokens += e.tokens; r.tokens_measured_for++; }
        }
      }
      // Polling: the same command again and again, nothing else in between, each within 5 minutes.
      const tail = run[run.length - 1];
      if (tail && (tail.key !== e.key || (e.ts != null && tail.end_ts != null && e.ts - tail.end_ts > POLL_GAP_MS))) flushPolls();
      run.push(e);
      if (SETUP.has(e.cls)) epoch++;
      last.set(e.key, { ev: e, epoch });
    }
    flushPolls();
  }
  return m;
}
