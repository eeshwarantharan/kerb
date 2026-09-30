// Session recap (4.11.3) and the status line (4.11.2). Both read only summary.json.
import { formatBytes, formatDuration, formatCount } from '../util/core.js';
import { saveCount } from '../store/summary.js';

export const AGENT_NAMES = {
  claude: 'Claude Code',
  copilot: 'GitHub Copilot',
  'copilot-cli': 'Copilot CLI',
  cursor: 'Cursor',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

export function tierLabel(tier, agent) {
  if (tier === 'enforced') return `enforced via ${AGENT_NAMES[agent] || agent || 'agent'} hooks`;
  return 'best effort: Kerb only sees commands run through kerb run';
}

/**
 * The recap block, or '' when nothing was saved.
 * @param {{ tier: string | null, agent: string | null, counters: any }} session
 */
export function renderRecap(session, { title = 'this session' } = {}) {
  const c = session.counters;
  if (!saveCount(c)) return '';
  const rows = [];
  if (c.reruns_avoided) {
    const tokens = Math.round(c.avoided_bytes / 4);
    rows.push(['re-runs avoided', `${c.reruns_avoided}  (saved ${formatDuration(c.avoided_ms)} of run time, ≈ ${formatCount(tokens)} tokens of output)`]);
  }
  const policy = c.by_reason.policy_blocked || 0;
  const human = c.by_reason.human_only || 0;
  if (policy) rows.push(['blocked early', `${policy} command${policy === 1 ? '' : 's'} refused before running`]);
  if (human) rows.push(['human-only', `${human} refused (for the user to run)`]);
  if (c.waits) rows.push(['polls folded', `${c.polls_folded + c.waits} attempts in ${c.waits} call${c.waits === 1 ? '' : 's'}`]);
  if (c.trimmed_bytes > 0) rows.push(['noise trimmed', `${formatBytes(c.raw_bytes)} → ${formatBytes(c.shown_bytes)} shown`]);
  if (c.walls_new || c.walls_suspected) {
    const parts = [];
    if (c.walls_new) parts.push(`${c.walls_new} new, learned from a policy denial`);
    if (c.walls_suspected) parts.push(`${c.walls_suspected} suspected`);
    rows.push(['walls', parts.join(', ')]);
  }
  if (c.hangs_killed) rows.push(['hangs killed', String(c.hangs_killed)]);
  const width = Math.max(...rows.map((r) => r[0].length));
  const tier = session.tier ? ` (${tierLabel(session.tier, session.agent)})` : '';
  return [`kerb recap · ${title}${tier}`, ...rows.map(([k, v]) => `  ${k.padEnd(width)}   ${v}`)].join('\n');
}

/**
 * One status line, under 80 characters; zero segments dropped.
 * @param {any} summary
 * @param {{ counters: any }} session
 * @param {{ segment?: boolean }} [o]
 */
export function renderStatusline(summary, session, o = {}) {
  const c = session.counters;
  const segs = [];
  if (c.reruns_avoided) segs.push(`${c.reruns_avoided} re-run${c.reruns_avoided === 1 ? '' : 's'} avoided`);
  const blocked = c.by_reason.policy_blocked || 0;
  if (blocked) segs.push(`${blocked} blocked early`);
  if (c.polls_folded) segs.push(`${c.polls_folded} poll${c.polls_folded === 1 ? '' : 's'} folded`);
  if (c.trimmed_bytes) segs.push(`${formatBytes(c.trimmed_bytes)} noise trimmed`);
  if (summary.walls_known) segs.push(`${summary.walls_known} wall${summary.walls_known === 1 ? '' : 's'} known`);
  const warn = [];
  if (summary.org_cache_expired) warn.push('org policy cache expired');
  if (summary.errors) warn.push('errors logged, run kerb doctor');
  const checked = (c.loop_checked || 0) + (c.loop_skipped || 0);
  if (c.loop_skipped >= 3 && c.loop_skipped / Math.max(1, checked) > 0.2) warn.push('hashing slow, run kerb doctor');
  let parts = [...warn, ...segs];
  let line = o.segment ? parts.join(' · ') : ['kerb', ...parts].join(' · ');
  // Keep it under 80 characters: drop the least important segments first.
  while (line.length >= 80 && parts.length > 1) {
    parts = parts.slice(0, -1);
    line = o.segment ? parts.join(' · ') : ['kerb', ...parts].join(' · ');
  }
  if (line.length >= 80) line = `${line.slice(0, 78)}…`;
  return line;
}
