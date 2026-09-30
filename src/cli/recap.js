// kerb recap: the session recap (4.11.3), only when something was saved.
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { loadSummary, currentSession, saveCount } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderRecap } from '../ui/recap.js';
import { parseOpts } from './args.js';

export default async function recap(ctx, args) {
  const { opts } = parseOpts(args, { session: 'string' });
  const { root } = findRoot(ctx.cwd);
  const summary = loadSummary(path.join(root, '.kerb'));
  const session = opts.session && summary.sessions[opts.session] ? { id: opts.session, ...summary.sessions[opts.session] } : currentSession(summary);
  const off = loadConfig().values.recap === 'off';
  const text = off ? '' : renderRecap(session);
  if (ctx.json) {
    ctx.emitJson({ session: session.id, tier: session.tier, agent: session.agent, saves: saveCount(session.counters), counters: session.counters, text });
    return 0;
  }
  if (text) ctx.out(`${text}\n`);
  return 0;
}
