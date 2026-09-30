// Fingerprints and failure kinds (4.7.4).
import { createHash } from 'node:crypto';
import os from 'node:os';

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const DUR = '\\d+(?:\\.\\d+)?\\s?(?:ms|s|sec|secs|m|min|h)(?![A-Za-z0-9_])';
const DUR_RE = new RegExp(DUR, 'g');
const DUR_CONTEXT = new RegExp(`(\\bin |\\btook |\\bafter |time:\\s*|duration:\\s*|elapsed:?\\s*|Time:\\s*)${DUR}`, 'gi');
const DUR_LAST = new RegExp(`(^|\\s)${DUR}\\s*$`);

function tmpRoots() {
  const roots = new Set(['/private/tmp/', '/tmp/', '/var/folders/', '/private/var/folders/']);
  for (const t of [process.env.TMPDIR, os.tmpdir()]) {
    if (t) roots.add(t.endsWith('/') ? t : `${t}/`);
  }
  return [...roots].sort((a, b) => b.length - a.length);
}
const TMP_RE = new RegExp(`(?:${tmpRoots().map((r) => r.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})[^\\s:'"()\\[\\]]*`, 'g');
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Normalise one ANSI-stripped, redacted line so equivalent failures match (4.7.4). */
export function normalizeLine(line) {
  let s = line;
  if (/^kerb: exit /.test(s)) return null;
  s = s.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>');
  s = s.replace(new RegExp(`\\b\\d{1,2}/${MONTHS}/\\d{4}(?::\\d{2}:\\d{2}:\\d{2})?(?: [+-]\\d{4})?`, 'g'), '<TS>');
  s = s.replace(/\b\d{4}[/-]\d{2}[/-]\d{2}\b/g, '<TS>');
  s = s.replace(new RegExp(`\\b(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\\s+)?${MONTHS}\\s+\\d{1,2}\\b`, 'g'), '<TS>');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<TS>');
  s = s.replace(TMP_RE, (m) => `<TMP>/${m.replace(/\/+$/, '').split('/').pop()}`);
  s = s.replace(/\([^()]*\)/g, (group) => group.replace(DUR_RE, '<DUR>'));
  s = s.replace(DUR_CONTEXT, (_, pre) => `${pre}<DUR>`);
  s = s.replace(DUR_LAST, (_, pre) => `${pre}<DUR>`);
  s = s.replace(/0x[0-9a-fA-F]{6,}/g, '<ADDR>');
  s = s.replace(/\bpid[ :=]+\d+/gi, '<PID>');
  s = s.replace(/\bprocess \d+/g, '<PID>');
  s = s.replace(/\b(localhost|127\.0\.0\.1):(\d+)\b/g, (m, h, p) => (Number(p) >= 49152 ? `${h}:<PORT>` : m));
  s = s.replace(new RegExp(`RequestId:\\s*${UUID}`, 'gi'), 'RequestId: <REQ>');
  s = s.replace(/x-amz-request-id[:=]\s*[A-Za-z0-9+/=-]+/gi, 'x-amz-request-id: <REQ>');
  if (/request/i.test(s)) s = s.replace(new RegExp(UUID, 'g'), '<REQ>');
  return s.replace(/\s+$/, '');
}

const TRANSIENT_DEFAULT = [
  /ETIMEDOUT/, /ECONNRESET/, /ESOCKETTIMEDOUT/, /EAI_AGAIN/, /socket hang up/i, /502 Bad Gateway/i,
  /503 Service Unavailable/i, /504 Gateway Time-?out/i, /429 Too Many Requests/i, /TooManyRequests(?:Exception)?/,
  /ThrottlingException/, /Throttling:/, /RequestLimitExceeded/, /SlowDown/, /ProvisionedThroughputExceededException/,
  /rate limit exceeded/i, /RESOURCE_EXHAUSTED/, /UNAVAILABLE: /,
];
const PRIVATE_ADDR = /\b(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|::1)\b/i;
const DEPENDENCY_DEFAULT = [
  /ECONNREFUSED/, /connection refused/i, /could not connect to server/i, /is the server running/i,
  /Can't connect to (?:local )?MySQL server/i, /Connection to .* refused/i,
];
const FAIL_LINE = /(\b(?:error|errors|fail|failed|failure|failing|panic|exception|assert|assertion)\b|✗|✕|×|ERR!)/i;
const MAX_LINE = 4096;

/** Compile policy regexes (already linted: ≤200 chars, ≤50 per list); bad ones are skipped. */
export function compilePatterns(list = []) {
  const out = [];
  for (const p of list.slice(0, 50)) {
    if (typeof p !== 'string' || p.length > 200) continue;
    try { out.push(new RegExp(p)); } catch { /* lint reports it */ }
  }
  return out;
}

/**
 * Streaming analysis of output lines: fingerprint, failure kind, first failing line.
 */
export class Analyzer {
  /** @param {{ transient?: RegExp[], dependency?: RegExp[] }} [policy] compiled policy patterns */
  constructor(policy = {}) {
    this.hash = createHash('sha256');
    this.transient = [...TRANSIENT_DEFAULT, ...(policy.transient || [])];
    this.dependency = [...DEPENDENCY_DEFAULT, ...(policy.dependency || [])];
    this.sawTransient = false;
    this.sawDependency = false;
    this.firstFail = null;
    this.lastNonEmpty = null;
    this.lines = [];
    this.keepLines = 400;
  }

  /** @param {string} line ANSI-stripped, redacted */
  line(line) {
    const norm = normalizeLine(line);
    if (norm === null) return;
    this.hash.update(norm);
    this.hash.update('\n');
    if (line.trim()) this.lastNonEmpty = line;
    if (line.length > MAX_LINE) return;
    if (!this.sawTransient && this.transient.some((re) => re.test(line))) this.sawTransient = true;
    if (!this.sawDependency && (this.dependency.some((re) => re.test(line))
      || (/no route to host/i.test(line) && PRIVATE_ADDR.test(line)))) this.sawDependency = true;
    if (!this.firstFail && FAIL_LINE.test(line)) this.firstFail = line;
    if (this.lines.length < this.keepLines) this.lines.push(line);
  }

  /** @param {{ timedOut?: boolean }} [o] */
  result(o = {}) {
    const first = (this.firstFail || this.lastNonEmpty || '').trim();
    /** @type {'transient' | 'dependency' | 'ordinary'} */
    let kind = 'ordinary';
    if (o.timedOut || this.sawTransient) kind = 'transient';
    else if (this.sawDependency) kind = 'dependency';
    return {
      fingerprint: this.hash.digest('hex').slice(0, 32),
      kind,
      firstFailLine: first.length > 120 ? `${first.slice(0, 119)}…` : first,
    };
  }
}

/** Convenience: analyse a whole string. */
export function analyzeText(text, policy, o) {
  const a = new Analyzer(policy);
  for (const l of text.split('\n')) a.line(l);
  return a.result(o);
}
