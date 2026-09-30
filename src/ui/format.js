// Refusal and note templates, and colour (4.3, 4.11.6, 2.3).

const CODES = { yellow: 33, cyan: 36, dim: 2, red: 31, green: 32, bold: 1 };

/**
 * Colour only when the stream is a TTY, NO_COLOR is unset, and --no-color isn't given.
 * The user config `color` (auto|always|never) can force it.
 */
export function colorEnabled(stream, env = process.env, noColor = false, setting = 'auto') {
  if (noColor || setting === 'never') return false;
  if ('NO_COLOR' in env && env.NO_COLOR !== undefined) return false;
  if (setting === 'always') return true;
  return !!(stream && stream.isTTY);
}

/** @param {boolean} on @param {keyof CODES} color @param {string} s */
export function paint(on, color, s) {
  return on ? `\x1b[${CODES[color]}m${s}\x1b[0m` : s;
}

export const LOOP_REASONS = new Set(['identical_retry', 'deja_vu', 'breaker_open']);

/**
 * A refusal: reason, summary, evidence and next are template-filled, validated fields.
 * @typedef {{ reason: string, summary: string, evidence: string, next: string, key?: string|null,
 *   run?: string|null, exit: number, details?: Record<string, any> }} Refusal
 */

/** Human form, three lines, for stderr. @param {Refusal} r */
export function formatRefusal(r, color = false) {
  const tint = LOOP_REASONS.has(r.reason) ? 'cyan' : 'yellow';
  const head = paint(color, tint, `kerb: ${r.reason}`);
  const lines = [`${head} · ${oneLine(r.summary)}`];
  if (r.evidence) lines.push(`      ${oneLine(r.evidence)}`);
  lines.push(`      next: ${oneLine(r.next)}`);
  return `${lines.join('\n')}\n`;
}

/** JSON form (4.3). @param {Refusal} r */
export function refusalJson(r) {
  return {
    refused: true,
    reason: r.reason,
    key: r.key ?? null,
    summary: r.summary,
    evidence: { text: r.evidence, ...(r.details || {}) },
    next: r.next,
    exit: r.exit,
    run: r.run ?? null,
  };
}

/** A one-line note: `kerb: note · <text>`, dim in a TTY. */
export function formatNote(text, color = false) {
  return `${paint(color, 'dim', `kerb: note · ${oneLine(text)}`)}\n`;
}

/** Collapse whitespace and cap length so templates stay one line. */
export function oneLine(s, max = 300) {
  const t = String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
