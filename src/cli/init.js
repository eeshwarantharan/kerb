// kerb init [--agent <name>] [--dry-run] [--refresh]: wire Kerb into detected agents. Idempotent.
import { findRoot } from '../util/repo.js';
import { UsageError } from '../util/core.js';
import { parseOpts } from './args.js';
import { planInit, applyInit } from '../init/install.js';
import { AGENT_DESCRIPTORS } from '../init/agents.js';

export default async function init(ctx, args) {
  const { opts } = parseOpts(args, { agent: 'string', 'dry-run': 'bool', refresh: 'bool' });
  const agents = opts.agent ? opts.agent.split(',').map((s) => s.trim()).filter(Boolean) : null;
  for (const a of agents || []) {
    if (!AGENT_DESCRIPTORS.some((d) => d.id === a)) throw new UsageError(`unknown agent ${a}; known: ${AGENT_DESCRIPTORS.map((d) => d.id).join(', ')}`);
  }
  const { root } = findRoot(ctx.cwd);
  const plan = planInit(root, { agents, refresh: !!opts.refresh });
  const dry = !!opts['dry-run'];
  if (!dry) applyInit(root, plan);
  const files = plan.actions.map((a) => ({ file: a.file, change: a.before === null ? 'create' : 'update', agent: a.agent || null }));
  if (ctx.json) {
    ctx.emitJson({ root, dry_run: dry, files, unchanged: plan.unchanged.map((a) => a.file), agents: plan.agents, notes: plan.notes, hook_command: plan.inv.command });
    return 0;
  }
  ctx.out(`kerb init${dry ? ' --dry-run' : ''} · ${root}\n`);
  if (!files.length) ctx.out('  nothing to change; already set up\n');
  for (const f of files) ctx.out(`  ${dry ? `would ${f.change}` : f.change === 'create' ? 'created' : 'updated'} ${f.file}\n`);
  for (const u of plan.unchanged) ctx.out(`  unchanged ${u.file}\n`);
  ctx.out('agents\n');
  const names = Object.fromEntries(AGENT_DESCRIPTORS.map((d) => [d.id, d.name]));
  const rows = Object.entries(plan.agents).map(([id, a]) => [names[id] || id, `${a.tier} (${a.tier === 'enforced' ? a.how : 'instructions only; Kerb only sees commands run through kerb run'})`]);
  rows.push(['any other agent', 'best effort (AGENTS.md instructions; Kerb only sees commands run through kerb run)']);
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [n, t] of rows) ctx.out(`  ${n.padEnd(w)}  ${t}\n`);
  for (const n of plan.notes) ctx.out(`note: ${n}\n`);
  ctx.out(dry ? 'dry run: nothing was changed\n' : 'check it: kerb doctor · undo: kerb uninstall\n');
  return 0;
}
