// kerb doctor: check installation, hook paths, policy, signature, state health and hashing speed.
// Prints exact fixes. Exit 1 when something is broken.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRoot } from '../util/repo.js';
import { readJson, homeKerbDir } from '../util/fsx.js';
import { now } from '../util/core.js';
import { Store } from '../store/jsonl.js';
import { loadSummary, rangeTotals } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { readRepoPolicy } from '../bound/policy.js';
import { orgLayer } from '../bound/org.js';
import { lex } from '../parse/tokenize.js';
import { parseOpts } from './args.js';
import { kerbInvocation, MANIFEST } from '../init/install.js';
import { AGENT_DESCRIPTORS } from '../init/agents.js';
import { computeScope } from '../loop/scope.js';
import { hashWorkspace } from '../loop/workspace.js';
import { refreshOrgIfDue } from '../engine.js';

/** The executable paths at the start of a hook command. */
export function hookPaths(command) {
  let words;
  try { words = lex(command).filter((t) => t.t === 'word').map((t) => t.v); } catch { return []; }
  const i = words.indexOf('hook');
  const head = i === -1 ? words.slice(0, 1) : words.slice(0, i);
  return head;
}

export async function runDoctor(root) {
  /** @type {{ level: 'ok' | 'warn' | 'fail', text: string, fix?: string }[]} */
  const checks = [];
  const add = (level, text, fix) => checks.push({ level, text, fix });
  const cfg = loadConfig();
  const inv = kerbInvocation();
  const current = inv.binary ? [inv.binary] : [inv.node, inv.script];

  // Installation and hook paths.
  const manifest = readJson(path.join(root, MANIFEST), null);
  if (!manifest) add('warn', 'Kerb is not wired into any agent in this repo', 'kerb init');
  else {
    for (const [id, info] of Object.entries(manifest.agents || {})) {
      const d = AGENT_DESCRIPTORS.find((x) => x.id === id);
      if (!d) continue;
      if (info.tier !== 'enforced' || !d.hookCommands) { add('ok', `${d.name}: best effort (instructions only)`); continue; }
      let cmds;
      try { cmds = d.hookCommands(root); } catch (e) { add('fail', `${d.name}: ${e.message}`, `fix ${d.settingsFile}, then kerb init --agent ${id}`); continue; }
      const missing = Object.entries(cmds).filter(([, c]) => !c).map(([e]) => e);
      if (missing.length) {
        add('fail', `${d.name}: missing ${missing.join(', ')} hook${missing.length === 1 ? '' : 's'} in ${d.settingsFile}`, `kerb init --agent ${id}`);
        continue;
      }
      let stale = null;
      let gone = null;
      for (const c of Object.values(cmds)) {
        const p = hookPaths(c);
        for (const x of p) if (!fs.existsSync(x)) gone = gone || x;
        if (p.join('\0') !== current.join('\0')) stale = stale || p.join(' ');
      }
      if (gone) add('fail', `${d.name}: hooks point at ${gone}, which no longer exists (Node or Kerb moved)`, 'kerb init --refresh');
      else if (stale) add('warn', `${d.name}: hooks run ${stale}, not this Kerb (${current.join(' ')})`, 'kerb init --refresh');
      else add('ok', `${d.name}: enforced, hooks installed with absolute paths`);
    }
  }
  if (cfg.values['claude.rewrite'] === true) {
    add('warn', 'claude.rewrite is set, but Claude Code can only rewrite a command by approving it or forcing a prompt, so Kerb keeps observe mode', 'kerb config set claude.rewrite false');
  }

  // Policy.
  const repo = readRepoPolicy(root);
  if (repo) {
    const errs = repo.problems.filter((p) => p.level === 'error');
    if (errs.length) add('fail', `kerb.policy.json: ${errs.map((e) => e.message).join('; ')}`, 'kerb policy lint');
    else add('ok', `kerb.policy.json is valid${repo.problems.length ? ` (${repo.problems.length} warning${repo.problems.length === 1 ? '' : 's'})` : ''}`);
  }
  if (cfg.managed && cfg.managed.org) {
    await refreshOrgIfDue(true);
    const org = orgLayer(cfg.managed, now());
    if (!org || !org.layer) add('fail', `org policy: no verified bundle${org && org.status.last_error ? ` (${org.status.last_error})` : ''}`, 'check org.bundle_url and org.public_key in the managed config, and your network');
    else if (org.status.stale) add('warn', `org policy v${org.status.version}: cache expired (fetched ${new Date(org.status.fetched_at).toISOString()}); still in use`, 'reconnect to the network that serves the bundle');
    else add('ok', `org policy v${org.status.version}: signature verified${org.status.offline ? ' (offline; using cache)' : ''}`);
  }

  // State health.
  const store = new Store(root);
  if (fs.existsSync(store.file)) {
    try { store.read({ repair: false }); add('ok', 'state: .kerb/runs.jsonl is intact'); } catch (e) { add('fail', e.message, 'move .kerb/runs.jsonl aside (history is lost, Kerb keeps working)'); }
  }
  const summary = loadSummary(store.dir);
  let errLines = 0;
  try { errLines = fs.readFileSync(path.join(homeKerbDir({ create: false }), 'errors.log'), 'utf8').split('\n').filter(Boolean).length; } catch { /* none */ }
  if (summary.errors || errLines) add('warn', `Kerb logged ${summary.errors || errLines} internal error${(summary.errors || errLines) === 1 ? '' : 's'} (hooks failed open)`, 'see ~/.kerb/errors.log and report it');
  const hooks = summary.hooks || {};
  for (const [agent, h] of Object.entries(hooks)) {
    if (h.pre >= 5) {
      const share = Math.round((100 * (h.full || 0)) / h.pre);
      add(share >= 90 ? 'ok' : 'warn', `${agent}: ${share}% of observed commands fully recorded (pre and post)`, share >= 90 ? undefined : 'kerb init --refresh, then restart the agent');
    }
  }

  // Hashing speed.
  const git = fs.existsSync(path.join(root, '.git'));
  const scope = computeScope(root, root, {});
  const h = hashWorkspace({ root, git, policy: {}, env: process.env }, scope, 5000);
  if (h.skipped) add('warn', 'hashing the whole repo took over 5 s', git ? 'git config core.fsmonitor true && git config core.untrackedCache true' : 'add large generated folders to .kerbignore');
  else add(h.ms > 300 ? 'warn' : 'ok', `hashing the whole repo takes ${h.ms} ms (${git ? 'git' : 'walk'} mode)`,
    h.ms > 300 ? (git ? 'git config core.fsmonitor true && git config core.untrackedCache true' : 'add large generated folders to .kerbignore') : undefined);
  const week = rangeTotals(summary, now(), 7);
  const checked = week.loop_checked + week.loop_skipped;
  if (week.loop_skipped) {
    const pct = Math.round((100 * week.loop_skipped) / Math.max(1, checked));
    add(pct > 10 ? 'warn' : 'ok', `loop checks skipped for the hash budget: ${week.loop_skipped} of ${checked} this week (${pct}%)`,
      pct > 10 && git ? 'git config core.fsmonitor true && git config core.untrackedCache true' : undefined);
  }
  if (git) {
    const cfgv = (k) => { const r = spawnSync('git', ['-C', root, 'config', '--get', k], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
    if (cfgv('core.trustctime') === 'false') add('warn', 'core.trustctime is false: an edit that restores its mtime may look unchanged to Kerb', 'git config core.trustctime true');
    const st = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', 'kerb.policy.json', '.kerbignore'], { encoding: 'utf8' });
    if (st.status === 0 && st.stdout.trim()) add('warn', `policy files changed since the last commit: ${st.stdout.trim().split('\n').map((l) => l.slice(3)).join(', ')}`, 'review the change (an agent may have edited it) and commit or revert it');
  }
  return checks;
}

export default async function doctor(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const checks = await runDoctor(root);
  const failed = checks.some((c) => c.level === 'fail');
  if (ctx.json) {
    ctx.emitJson({ root, ok: !failed, checks });
    return failed ? 1 : 0;
  }
  ctx.out(`kerb doctor · ${root}\n`);
  for (const c of checks) {
    ctx.out(`  ${c.level.padEnd(4)} · ${c.text}\n`);
    if (c.fix) ctx.out(`         fix: ${c.fix}\n`);
  }
  ctx.out(failed ? 'kerb doctor · problems found\n' : 'kerb doctor · all good\n');
  return failed ? 1 : 0;
}
