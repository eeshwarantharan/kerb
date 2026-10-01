// kerb scan [--since 30d] [--agent claude,codex,gemini] [--json]: replay past agent sessions in
// this repo and show what Kerb would have stopped (KERB-V2 10.1). Reads local transcripts only;
// writes nothing and sends nothing.
import os from 'node:os';
import { findRoot } from '../util/repo.js';
import { now, parseDuration, formatBytes, formatDuration, formatCount, UsageError } from '../util/core.js';
import { loadConfig } from '../config.js';
import { mergeLayers, readRepoPolicy, layerSource } from '../bound/policy.js';
import { orgLayer } from '../bound/org.js';
import { compileCheckCommands } from '../parse/classify-cmd.js';
import { caBundleFor } from '../insight/envclass.js';
import { replay } from '../scan/replay.js';
import { parseOpts } from './args.js';

export const READERS = {
  claude: () => import('../scan/claude.js'),
  codex: () => import('../scan/codex.js'),
  gemini: () => import('../scan/gemini.js'),
};

/**
 * Read and replay every session of the chosen agents. Library entry point for `kerb card --scan`.
 * @param {string} root
 * @param {{ sinceMs: number, agents?: string[], env?: NodeJS.ProcessEnv, home?: string }} o
 */
export async function runScan(root, o) {
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  const sinceTs = now() - o.sinceMs;
  const config = loadConfig();
  // Today's org and repo rules; learning is replayed from the transcripts themselves.
  const layers = [];
  const org = orgLayer(config.managed, now());
  if (org && org.layer) layers.push(org.layer);
  const repo = readRepoPolicy(root);
  if (repo) layers.push({ name: 'repo', policy: repo.policy, source: layerSource('repo') });
  const policy = { ...mergeLayers(layers), suspected: [] };
  const sessions = [];
  const counts = {};
  const skipped = [];
  let usage = false;
  for (const agent of o.agents || Object.keys(READERS)) {
    const reader = await READERS[agent]();
    const ids = new Set();
    for (const f of reader.sessionFiles(root, { env, home, sinceTs })) {
      let r;
      try { r = reader.readSession(f.path, root); } catch (e) { r = { skipped: `could not be read (${e.message})` }; }
      if (r.skipped) {
        if (r.skipped !== 'outside this repo') skipped.push({ agent, file: f.path, reason: r.skipped });
        continue;
      }
      const events = r.events.filter((e) => e.ts == null || e.ts >= sinceTs);
      if (!events.length) continue;
      if (r.usage) usage = true;
      if (!f.subagent) ids.add(f.session);
      sessions.push({ agent, session: f.session, events });
    }
    if (ids.size) counts[agent] = { name: reader.NAME, sessions: ids.size };
  }
  const metrics = replay(sessions, { root, policy, checkCommands: compileCheckCommands(policy.check_commands), home });
  return { basis: 'replayed', since_ms: o.sinceMs, agents: counts, sessions: sessions.length, usage_recorded: usage, ca_bundle: !!caBundleFor(config, policy), skipped, metrics: { basis: 'replayed', ...metrics } };
}

const pad = (s, n) => String(s).padStart(n);

/** The human-readable block (also used for the README hero). */
export function renderScan(r, period) {
  const m = r.metrics;
  const who = Object.values(r.agents).map((a) => `${a.sessions} ${a.name} session${a.sessions === 1 ? '' : 's'}`).join(', ') || 'no agent sessions';
  const lines = [`kerb scan · ${period} · ${who} in this repo (replayed)`];
  const tok = (n, measured) => (measured ? ` · ≈ ${formatCount(n)} tokens (measured from transcripts)` : '');
  const rows = [];
  const ir = m.identical_retries;
  if (ir.count) rows.push([String(ir.count), `test re-run${ir.count === 1 ? '' : 's'} with nothing changed`, `${formatDuration(ir.run_time_ms)} of run time${tok(ir.tokens, ir.tokens_measured_for > 0)}`]);
  if (m.policy_blocked.count) rows.push([String(m.policy_blocked.count), `command${m.policy_blocked.count === 1 ? '' : 's'} your policy blocks`, 'refused before running']);
  if (m.blocked_host_retries.count) rows.push([String(m.blocked_host_retries.count), `retr${m.blocked_host_retries.count === 1 ? 'y' : 'ies'} against blocked hosts`, m.blocked_host_retries.hosts.slice(0, 3).join(', ')]);
  const env = m.environment;
  if (env.tls_interception) rows.push([String(env.tls_interception), `certificate error${env.tls_interception === 1 ? '' : 's'} (corporate TLS)`, r.ca_bundle ? 'CA bundle configured' : 'no CA bundle configured']);
  if (env.proxy_page) rows.push([String(env.proxy_page), `corporate proxy block page${env.proxy_page === 1 ? '' : 's'}`, '']);
  if (env.auth_expired) rows.push([String(env.auth_expired), `expired-credential failure${env.auth_expired === 1 ? '' : 's'}`, '']);
  if (m.noise.bytes_beyond_budget) rows.push([formatBytes(m.noise.bytes_beyond_budget), "of output beyond Kerb's budget", m.noise.tokens_measured_for ? `≈ ${formatCount(m.noise.tokens)} tokens (measured from transcripts)` : '']);
  if (m.hangs.count) rows.push([String(m.hangs.count), `command${m.hangs.count === 1 ? '' : 's'} that hung or were interrupted`, m.hangs.run_time_ms ? `${formatDuration(m.hangs.run_time_ms)} waiting` : '']);
  if (m.polling.attempts_folded) rows.push([String(m.polling.attempts_folded), `poll${m.polling.attempts_folded === 1 ? '' : 's'} kerb wait-for would fold`, `into ${m.polling.groups} call${m.polling.groups === 1 ? '' : 's'}`]);
  if (!rows.length) lines.push(`  nothing Kerb would have stopped in ${m.commands} shell command${m.commands === 1 ? '' : 's'}`);
  const w0 = Math.max(...rows.map((x) => x[0].length), 1);
  const w1 = Math.max(...rows.map((x) => x[1].length), 1);
  for (const [n, what, extra] of rows) lines.push(`  ${pad(n, w0)} ${what.padEnd(w1)}   ${extra}`.trimEnd());
  return lines.join('\n');
}

export default async function scan(ctx, args) {
  const { opts } = parseOpts(args, { since: 'string', agent: 'string' });
  const since = opts.since || '30d';
  let sinceMs;
  try { sinceMs = parseDuration(since); } catch { throw new UsageError(`--since takes a duration like 30d (got ${since})`); }
  const agents = opts.agent ? opts.agent.split(',').map((s) => s.trim()).filter(Boolean) : null;
  for (const a of agents || []) if (!Object.hasOwn(READERS, a)) throw new UsageError(`unknown agent ${a}; scan reads: ${Object.keys(READERS).join(', ')}`);
  const { root } = findRoot(ctx.cwd);
  const r = await runScan(root, { sinceMs, agents, env: ctx.env });
  if (ctx.json) {
    ctx.emitJson({ since, ...r });
    return 0;
  }
  const period = /^\d+d$/.test(since) ? `${parseInt(since, 10)} days` : `last ${since}`;
  ctx.out(`${renderScan(r, period)}\n`);
  if (r.metrics.commands && !r.usage_recorded) ctx.out('  token counts: the transcripts have no usage data, so only bytes are shown\n');
  for (const s of r.skipped.slice(0, 5)) ctx.out(`note: skipped ${s.file} (${s.reason})\n`);
  if (r.skipped.length > 5) ctx.out(`note: skipped ${r.skipped.length - 5} more files\n`);
  ctx.out('replayed: what Kerb\'s rules would have done; nothing was run, and nothing left this machine\n');
  return 0;
}
