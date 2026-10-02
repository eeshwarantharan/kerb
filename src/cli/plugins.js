// kerb plugins [list] | approve <path> | revoke <path>: the plugins listed for this repo and
// whether each may load (KERB-V2 11.3). `approve` (human-only) records a person's approval of a
// repo-listed plugin's current hash; `revoke` removes it.
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { now, UsageError } from '../util/core.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { loadSummary } from '../store/summary.js';
import { Store } from '../store/jsonl.js';
import { requireHuman } from '../bound/human.js';
import { pluginStatus, statusWarning, setApproval } from '../platform/plugins.js';
import { parseOpts } from './args.js';

const LABEL = { ok: 'loads', needs_approval: 'needs approval', hash_mismatch: 'hash mismatch: not loaded', missing: 'missing: not loaded' };

export default async function plugins(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const [sub = 'list', target, ...extra] = positionals;
  if (!['list', 'approve', 'revoke'].includes(sub) || extra.length || (sub !== 'list' && !target)) throw new UsageError('usage: kerb plugins [list] | approve <path> | revoke <path>');
  const { root } = findRoot(ctx.cwd);
  const config = loadConfig();
  const policy = loadPolicy(root, config, now());
  const all = pluginStatus(root, config, policy);
  if (sub === 'list') {
    const counts = loadSummary(new Store(root).dir).plugins || {};
    const rows = all.map(({ bytes, ...p }) => (void bytes, { path: p.path, file: p.file, layer: p.layer, source: p.source, sha256: p.sha256, actual: p.actual, status: p.status }));
    if (ctx.json) { ctx.emitJson({ plugins: rows, counts }); return 0; }
    if (!rows.length) { ctx.out('kerb plugins · none listed (add { "path", "sha256" } entries under "plugins" in kerb.policy.json)\n'); return 0; }
    ctx.out(`kerb plugins · ${rows.length} listed\n`);
    for (const r of rows) ctx.out(`  ${r.path} · ${LABEL[r.status]} · ${r.source}${r.status === 'needs_approval' ? ` · kerb plugins approve ${r.path}` : ''}\n`);
    for (const [name, c] of Object.entries(counts)) if (c.timeouts || c.errors) ctx.out(`  ${name}: ${c.calls} calls, ${c.timeouts} over the 50 ms budget, ${c.errors} errors (skipped)\n`);
    return 0;
  }
  const file = path.resolve(ctx.cwd, target);
  const p = all.find((x) => x.file === file);
  if (!p) throw new UsageError(`${target} is not listed under "plugins" in any policy`);
  if (sub === 'revoke') {
    setApproval(p.file, null);
    if (ctx.json) ctx.emitJson({ revoked: p.path });
    else ctx.out(`kerb plugins · approval of ${p.path} removed; it won't load\n`);
    return 0;
  }
  if (p.layer !== 'repo') throw new UsageError(`${p.path} is listed by the ${p.source}, which is approval enough`);
  if (p.status === 'hash_mismatch' || p.status === 'missing') throw new UsageError(statusWarning(p));
  if (p.status === 'ok') { if (ctx.json) ctx.emitJson({ approved: p.path, sha256: p.sha256 }); else ctx.out(`kerb plugins · ${p.path} is already approved\n`); return 0; }
  ctx.err(`kerb plugins · ${p.path} (${p.bytes.length} bytes, sha256 ${p.sha256}) runs inside Kerb with your permissions. Read it before you approve it.\n`);
  requireHuman(`kerb plugins approve ${p.path}`);
  setApproval(p.file, p.sha256);
  if (ctx.json) ctx.emitJson({ approved: p.path, sha256: p.sha256 });
  else ctx.out(`kerb plugins · approved ${p.path} at sha256 ${p.sha256.slice(0, 12)}…; a changed file needs approval again\n`);
  return 0;
}
