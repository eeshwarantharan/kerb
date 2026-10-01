// kerb ledger [--json]: the attempt ledger for the last 24 hours on this branch (KERB-V2 7.4).
import { findRoot, branchOf } from '../util/repo.js';
import { now } from '../util/core.js';
import { prepare } from '../engine.js';
import { renderLedger, recentKeys, WINDOW_MS } from '../insight/ledger.js';
import { verification } from '../insight/verify.js';
import { parseOpts } from './args.js';

export default async function ledger(ctx, args) {
  parseOpts(args, {});
  const prep = prepare(ctx, { command: 'true', reap: false });
  const recs = prep.store.read();
  const nowTs = now();
  const keys = recentKeys(recs, nowTs - WINDOW_MS).slice(0, 3);
  const v = verification({ root: prep.root, git: prep.git, recs, session: null, policy: prep.policy, env: ctx.env, keys, anySession: true });
  const text = renderLedger({ root: prep.root, store: prep.store, recs, nowTs, branch: branchOf(findRoot(ctx.cwd).root), verification: Object.fromEntries(v.map((x) => [x.key, x])) });
  if (ctx.json) { ctx.emitJson({ text, keys, verification: v }); return 0; }
  ctx.out(text ? `${text}\n` : 'kerb ledger · no check runs in the last 24 hours\n');
  return 0;
}
