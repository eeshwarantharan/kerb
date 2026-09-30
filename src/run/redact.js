// Redaction (4.14.3), streaming-safe with a 512-byte carry-over (4.6.1).
// Works on latin1 strings so every byte maps to one char and logs stay byte-exact.

export const REDACTED = '[REDACTED]';
const CARRY = 512;
const MAX_HOLD = 64 * 1024;

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Patterns; a `keep` group is preserved before the replacement. */
const PATTERNS = [
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g },
  { re: /AKIA[0-9A-Z]{16}/g },
  { re: /(aws_secret_access_key["']?\s*[=:]\s*["']?)[A-Za-z0-9/+=]{16,}/gi, keep: true },
  { re: /github_pat_[A-Za-z0-9_]{50,}/g },
  { re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { re: /xox[baprs]-[A-Za-z0-9-]+/g },
  { re: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },
  { re: /eyJ[\w-]+\.[\w-]+\.[\w-]+/g },
  { re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, keep: true },
  { re: /(:\/\/)[^/\s:@'"]+:[^/\s@'"]+@/g, keep: true, suffix: '@' },
  { re: /((?:password|passwd|secret|token|api[_-]?key)["']?\s*[=:]\s*)(?!\[REDACTED\])[^\s'"]+/gi, keep: true },
];

/** Redact a complete string. */
export function redactText(s) {
  let out = s;
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    out = out.replace(p.re, (...m) => (p.keep ? `${m[1]}${REDACTED}${p.suffix || ''}` : REDACTED));
  }
  return out;
}

/** All match spans of every pattern in s. */
function spans(s) {
  const out = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(s))) {
      out.push([m.index, m.index + m[0].length]);
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  return out;
}

/**
 * Streaming redactor: push latin1 chunks, get redacted text that is safe to emit.
 * A secret split across chunk boundaries is still caught.
 */
export class StreamRedactor {
  constructor() {
    this.buf = '';
    this.inKey = false;
  }

  /** @param {string} chunk latin1 */
  push(chunk) {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inKey) {
        const end = KEY_END.exec(this.buf);
        if (!end) {
          // Drop key material; keep a tail so a split END marker is still found.
          this.buf = this.buf.slice(-64);
          return out;
        }
        this.buf = this.buf.slice(end.index + end[0].length);
        this.inKey = false;
        continue;
      }
      const begin = KEY_BEGIN.exec(this.buf);
      if (begin && !KEY_END.test(this.buf.slice(begin.index))) {
        out += redactText(this.buf.slice(0, begin.index)) + REDACTED;
        this.buf = this.buf.slice(begin.index + begin[0].length);
        this.inKey = true;
        continue;
      }
      break;
    }
    let cut = this.buf.length - CARRY;
    if (cut <= 0) return out;
    for (const [s, e] of spans(this.buf)) {
      if (s < cut && e > cut && cut - s <= MAX_HOLD) cut = s;
    }
    // Don't split just after a partial BEGIN marker.
    const dash = this.buf.lastIndexOf('-----BEGIN', cut);
    if (dash !== -1 && dash > cut - 40) cut = dash;
    out += redactText(this.buf.slice(0, cut));
    this.buf = this.buf.slice(cut);
    return out;
  }

  /** Flush the carry-over. */
  end() {
    if (this.inKey) {
      this.buf = '';
      return '';
    }
    const out = redactText(this.buf);
    this.buf = '';
    return out;
  }
}
