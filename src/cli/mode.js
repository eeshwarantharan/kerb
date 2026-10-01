// kerb mode: the current mode (shadow or enforce), where it comes from, and what shadow mode
// would have stopped so far (KERB-V2 10.2).
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { now } from '../util/core.js';
import { loadConfig } from '../config.js';
import { loadSummary, totalsSince } from '../store/summary.js';
import { effectiveMode, daysLeft, shadowPrompt } from '../mode.js';
import { wouldStopped } from '../ui/recap.js';
import { parseOpts } from './args.js';

const SOURCES = {
  managed: "set by your organisation's managed config",
  repo: 'recorded for this repo in .kerb/mode.json',
  user: 'from your user config (kerb config set mode …)',
  default: 'the default where kerb init never ran',
};

const day = (ts) => new Date(ts).toISOString().slice(0, 10);

export default async function mode(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const config = loadConfig();
  const nowTs = now();
  const m = effectiveMode(root, config, nowTs);
  const summary = loadSummary(path.join(root, '.kerb'));
  const totals = m.mode === 'shadow' ? totalsSince(summary, m.since || 0) : null;
  if (ctx.json) {
    ctx.emitJson({
      mode: m.mode, source: m.source, since: m.since, until: m.until, expired: m.expired, days_left: daysLeft(m, nowTs),
      would_refuse: totals ? totals.would_refuse : null, would_by_reason: totals ? totals.would_by_reason : null,
    });
    return 0;
  }
  if (m.mode === 'enforce') {
    ctx.out(`kerb mode · enforce (${SOURCES[m.source]}${m.since ? `, since ${day(m.since)}` : ''})\n`);
    ctx.out('  Kerb refuses blocked actions and retries that cannot help.\n');
    return 0;
  }
  const left = daysLeft(m, nowTs);
  const window = m.until ? `, until ${day(m.until)}${m.expired ? ', past its 7 days' : `, ${left} day${left === 1 ? '' : 's'} left`}` : '';
  ctx.out(`kerb mode · shadow (${SOURCES[m.source]}${m.since ? `, since ${day(m.since)}` : ''}${window})\n`);
  ctx.out('  Kerb records what it would stop and blocks nothing.\n');
  ctx.out(`  would have stopped: ${totals.would_refuse ? wouldStopped(totals) : 'nothing yet'}\n`);
  if (m.source !== 'managed') ctx.out('  review: kerb review-shadow · turn blocking on: kerb enforce (in your own terminal)\n');
  const prompt = shadowPrompt(root, config, summary, nowTs, { ignoreShown: true });
  if (prompt) ctx.out(`${prompt}\n`);
  return 0;
}
