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
    rows.push(['re-runs avoided', `${c.reruns_avoided}  (saved ${formatDuration(c.avoided_ms)} of run time, ≈ ${formatCount(tokens)} token${tokens === 1 ? '' : 's'} of output)`]);
  }
  if (c.cached_answers) rows.push(['answered from cache', `${c.cached_answers}  (saved ${formatDuration(c.cached_ms || 0)} of run time)`]);
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
  if (c.would_refuse) rows.push(['would have stopped', `${wouldStopped(c)} (shadow mode; nothing was blocked)`]);
  const width = Math.max(...rows.map((r) => r[0].length));
  const tier = session.tier ? ` (${tierLabel(session.tier, session.agent)}${c.would_refuse ? ' · shadow mode' : ''})` : '';
  return [`kerb recap · ${title}${tier}`, ...rows.map(([k, v]) => `  ${k.padEnd(width)}   ${v}`)].join('\n');
}

/** "4 re-runs and 1 blocked retry": what shadow mode would have stopped, by kind. */
export function wouldStopped(c) {
  const by = c.would_by_reason || {};
  const loops = (by.identical_retry || 0) + (by.deja_vu || 0) + (by.oscillating || 0) + (by.breaker_open || 0) + (by.cached || 0);
  const parts = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (loops) parts.push(plural(loops, 're-run', 're-runs'));
  if (by.policy_blocked) parts.push(plural(by.policy_blocked, 'blocked retry', 'blocked retries'));
  if (by.human_only) parts.push(plural(by.human_only, 'human-only command', 'human-only commands'));
  const other = (c.would_refuse || 0) - loops - (by.policy_blocked || 0) - (by.human_only || 0);
  if (other > 0) parts.push(plural(other, 'other command', 'other commands'));
  if (parts.length <= 1) return parts[0] || '0 commands';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
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
  if (c.trimmed_bytes) segs.push(`${formatBytes(c.trimmed_bytes)} noise trimmed`);
  if (summary.walls_known) segs.push(`${summary.walls_known} wall${summary.walls_known === 1 ? '' : 's'} known`);
  const problems = [];
  if (summary.org_cache_expired) problems.push('org cache expired');
  if (summary.errors) problems.push('errors logged');
  const checked = (c.loop_checked || 0) + (c.loop_skipped || 0);
  if (c.loop_skipped >= 3 && c.loop_skipped / Math.max(1, checked) > 0.2) problems.push('hashing slow');
  const warn = problems.length ? [`${problems.join(', ')}, run kerb doctor`] : [];
  // Verification and the failing series for the latest check key (KERB-V2 7.2, 7.3), as recorded
  // by the last check run or Stop, for this session; at most 12 hours old.
  const v = summary.verification;
  if (v && v.status && Date.now() - (v.ts || 0) < 12 * 3600_000 && (!v.session || !session.id || v.session === session.id)) {
    const files = v.files && v.files.length ? ` (${v.files.slice(0, 2).map((f) => f.split('/').pop()).join(', ')})` : '';
    const nums = Array.isArray(v.series) && v.series.length > 1 && v.series.some((c) => c != null) ? `failing ${v.series.map((c) => (c == null ? '✗' : c)).join('→')}` : null;
    segs.unshift(...[`tests: ${v.status}${files}`, nums].filter(Boolean));
  }
  if (summary.mode === 'shadow') segs.unshift(c.would_refuse ? `shadow: would have stopped ${c.would_refuse}` : 'shadow mode');
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
