// Shadow mode (KERB-V2 10.2). After `kerb init`, Kerb runs in shadow for 7 days: nothing is
// refused, every refusal it would have made is recorded as a `would_refuse` event, and a human
// turns blocking on with `kerb enforce`.
//
// Effective mode, first match wins: the managed config (`mode`, or `defaults.mode`), then this
// repo's .kerb/mode.json (written by init and by `kerb enforce`), then the user config `mode`,
// then `enforce` (v1 behaviour, for repos where init never ran).
import path from 'node:path';
import { atomicWrite, ensureDir, readJson } from './util/fsx.js';
import { totalsSince } from './store/summary.js';

export const MODE_FILE = path.join('.kerb', 'mode.json');
export const SHADOW_DAYS = 7;
/** After this many would-refuse events the recap asks for a review, even before day 7. */
export const SHADOW_PROMPT_EVENTS = 20;
const DAY_MS = 86_400_000;
const MODES = new Set(['shadow', 'enforce']);

export function readModeFile(root) {
  const m = readJson(path.join(root, MODE_FILE), null);
  return m && MODES.has(m.mode) ? m : null;
}

export function writeModeFile(root, rec) {
  ensureDir(path.join(root, '.kerb'));
  atomicWrite(path.join(root, MODE_FILE), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}

/** The mode the managed config sets, or null. */
export function managedMode(managed) {
  if (!managed) return null;
  if (MODES.has(managed.mode)) return managed.mode;
  if (managed.defaults && MODES.has(managed.defaults.mode)) return managed.defaults.mode;
  return null;
}

/** The mode the user config sets (ignoring managed defaults), or null. */
function userMode(config) {
  const v = config && config.values ? config.values.mode : null;
  return MODES.has(v) ? v : null;
}

/**
 * @param {string} root
 * @param {{ values: any, managed: any }} config from loadConfig()
 * @param {number} nowTs
 * @returns {{ mode: 'shadow' | 'enforce', source: 'managed' | 'repo' | 'user' | 'default',
 *   since: number | null, until: number | null, expired: boolean, prompted_at: number | null }}
 */
export function effectiveMode(root, config, nowTs) {
  const base = { since: null, until: null, expired: false, prompted_at: null };
  const m = managedMode(config && config.managed);
  if (m) return { ...base, mode: m, source: 'managed' };
  const file = readModeFile(root);
  if (file) {
    const until = file.mode === 'shadow' ? file.until ?? null : null;
    return {
      mode: file.mode,
      source: 'repo',
      since: file.since ?? null,
      until,
      expired: until != null && nowTs >= until,
      prompted_at: file.prompted_at ?? null,
    };
  }
  const u = userMode(config);
  if (u) return { ...base, mode: u, source: 'user' };
  return { ...base, mode: 'enforce', source: 'default' };
}

/**
 * Called by `kerb init`: start shadow mode unless a mode is already recorded for this repo, the
 * managed config sets one, or the user has chosen enforce.
 * @returns {{ started: boolean, mode: ReturnType<typeof effectiveMode> }}
 */
export function startShadowIfNew(root, config, nowTs, { dryRun = false } = {}) {
  const current = effectiveMode(root, config, nowTs);
  if (current.source === 'managed' || current.source === 'repo' || userMode(config) === 'enforce') {
    return { started: false, mode: current };
  }
  const rec = { mode: 'shadow', since: nowTs, until: nowTs + SHADOW_DAYS * DAY_MS, set_by: 'init' };
  if (!dryRun) writeModeFile(root, rec);
  return { started: true, mode: { mode: 'shadow', source: 'repo', since: rec.since, until: rec.until, expired: false, prompted_at: null } };
}

/** `kerb enforce`: the human turns blocking on for this repo. */
export function setEnforce(root, nowTs) {
  const prev = readModeFile(root);
  return writeModeFile(root, { mode: 'enforce', since: nowTs, set_by: 'human', shadow_since: prev && prev.mode === 'shadow' ? prev.since : undefined });
}

/** Record that the end-of-shadow prompt was shown, so it is shown once. */
export function markPrompted(root, nowTs) {
  const prev = readModeFile(root);
  if (prev) writeModeFile(root, { ...prev, prompted_at: nowTs });
}

/**
 * The review prompt is due once shadow mode has run its 7 days or recorded 20 would-refuse
 * events, and hasn't been shown yet. Mode stays shadow until a human acts.
 * @param {ReturnType<typeof effectiveMode>} mode
 * @param {number} wouldRefuse events since shadow mode started
 */
export function shadowPromptDue(mode, wouldRefuse, { ignoreShown = false } = {}) {
  if (mode.mode !== 'shadow' || mode.source !== 'repo') return false;
  if (mode.prompted_at && !ignoreShown) return false;
  return mode.expired || wouldRefuse >= SHADOW_PROMPT_EVENTS;
}

export function shadowPromptText(mode, wouldRefuse) {
  const why = mode.expired ? `shadow mode has run for ${SHADOW_DAYS} days` : `shadow mode has recorded ${wouldRefuse} commands it would have stopped`;
  const since = mode.since ? ` since ${new Date(mode.since).toISOString().slice(0, 10)}` : '';
  return [
    `kerb: shadow · ${why}; Kerb would have stopped ${wouldRefuse} command${wouldRefuse === 1 ? '' : 's'}${since}, and blocked nothing`,
    '      review them: kerb review-shadow · turn blocking on: kerb enforce (in your own terminal)',
  ].join('\n');
}

export function daysLeft(mode, nowTs) {
  if (!mode.until) return null;
  return Math.max(0, Math.ceil((mode.until - nowTs) / DAY_MS));
}

/**
 * The end-of-shadow prompt text when it is due, else null.
 * @param {any} summary loadSummary() result
 */
export function shadowPrompt(root, config, summary, nowTs, o = {}) {
  const mode = effectiveMode(root, config, nowTs);
  if (mode.mode !== 'shadow' || mode.source !== 'repo') return null;
  const n = totalsSince(summary, mode.since || 0).would_refuse || 0;
  return shadowPromptDue(mode, n, o) ? shadowPromptText(mode, n) : null;
}
