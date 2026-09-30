// Output shaping (4.6): streaming, bounded memory. Raw log (redacted), binary detection,
// ANSI/OSC stripping, carriage returns, repeat folding, head + tail budget.
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { StreamRedactor } from './redact.js';

export const DEFAULT_BUDGET = 12_000;
const BINARY_PROBE = 8 * 1024;
const MAX_TAIL_LINES = 100_000;

// CSI, OSC (BEL or ST terminated), DCS/PM/APC strings, two-byte escapes, other C0 controls except \t.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[P^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const HAS_CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

/** Remove ANSI escape sequences and stray control characters. */
export function stripAnsi(s) {
  return HAS_CONTROL.test(s) ? s.replace(ANSI_RE, '') : s;
}

/** Keep only the text after the last carriage return (progress bars), ignoring a CRLF ending. */
export function lastCr(s) {
  const t = s.endsWith('\r') ? s.slice(0, -1) : s;
  const i = t.lastIndexOf('\r');
  return i === -1 ? t : t.slice(i + 1);
}

/** Largest prefix of `buf` of at most `max` bytes that ends on a UTF-8 character boundary. */
export function utf8Prefix(buf, max) {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/**
 * @typedef {{ text: string, rawBytes: number, shownBytes: number, cut: boolean, omittedLines: number,
 *   binary: boolean, totalLines: number }} ShapeResult
 */

export class Shaper {
  /**
   * @param {{ budget?: number, logPath?: string | null, onLine?: (line: string) => void, logFlags?: string }} [o]
   */
  constructor(o = {}) {
    this.budget = Math.max(200, o.budget || DEFAULT_BUDGET);
    this.headBudget = Math.floor(this.budget * 0.25);
    this.tailBudget = this.budget - this.headBudget;
    this.maxLine = this.budget;
    this.logPath = o.logPath || null;
    this.onLine = o.onLine || null;
    this.logFd = this.logPath ? fs.openSync(this.logPath, o.logFlags || 'a', 0o600) : null;
    this.redactor = new StreamRedactor();
    this.decoder = new StringDecoder('utf8');
    this.rawBytes = 0;
    this.probed = 0;
    this.binary = false;
    this.partial = '';
    this.partialOverflow = false;
    this.last = null;
    this.lastCount = 0;
    this.head = [];
    this.headBytes = 0;
    this.headClosed = false;
    this.tail = [];
    this.tailStart = 0;
    this.tailBytes = 0;
    this.omitted = 0;
    this.truncatedLine = false;
    this.totalLines = 0;
  }

  /** @param {Buffer} chunk raw child output */
  push(chunk) {
    this.rawBytes += chunk.length;
    const red = this.redactor.push(chunk.toString('latin1'));
    if (red) this.consume(Buffer.from(red, 'latin1'));
  }

  /** Feed redacted bytes to the log and the shaping pipeline. */
  consume(buf) {
    if (this.logFd !== null) fs.writeSync(this.logFd, buf);
    if (this.probed < BINARY_PROBE) {
      const probe = buf.subarray(0, BINARY_PROBE - this.probed);
      this.probed += probe.length;
      if (probe.includes(0)) {
        this.binary = true;
        this.head = [];
        this.tail = [];
        this.tailStart = 0;
        this.partial = '';
      }
    }
    if (this.binary) return;
    const text = this.decoder.write(buf);
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      if (nl === -1) {
        this.addPartial(start === 0 ? text : text.slice(start));
        break;
      }
      const piece = text.slice(start, nl);
      if (this.partial) {
        this.addPartial(piece);
        this.flushLine(this.takePartial());
      } else if (piece.length > this.maxLine) {
        this.addPartial(piece);
        this.flushLine(this.takePartial());
      } else {
        this.flushLine(piece);
      }
      start = nl + 1;
    }
  }

  addPartial(t) {
    if (!t) return;
    if (this.partial.length >= this.maxLine) { this.partialOverflow = true; return; }
    const room = this.maxLine - this.partial.length;
    if (t.length > room) {
      this.partial += t.slice(0, room);
      this.partialOverflow = true;
    } else this.partial += t;
  }

  takePartial() {
    let line = this.partial;
    if (this.partialOverflow) line = utf8Prefix(Buffer.from(line), this.maxLine).toString('utf8');
    const overflow = this.partialOverflow;
    this.partial = '';
    this.partialOverflow = false;
    return overflow ? { line, overflow } : line;
  }

  flushLine(input) {
    let raw = input;
    let overflow = false;
    if (typeof input === 'object') { raw = input.line; overflow = input.overflow; }
    let line = stripAnsi(raw.indexOf('\r') === -1 ? raw : lastCr(raw));
    if (overflow) {
      line += ' [kerb] line cut';
      this.truncatedLine = true;
    }
    if (this.onLine) this.onLine(line);
    if (this.last !== null && line === this.last) {
      this.lastCount++;
      return;
    }
    this.flushRepeat();
    this.last = line;
    this.lastCount = 1;
  }

  flushRepeat() {
    if (this.last === null) return;
    if (this.lastCount >= 3) {
      this.emit(this.last);
      this.emit(`[kerb] previous line repeated ${this.lastCount - 1} more times`);
    } else {
      for (let i = 0; i < this.lastCount; i++) this.emit(this.last);
    }
    this.last = null;
    this.lastCount = 0;
  }

  emit(line) {
    this.totalLines++;
    let bytes = Buffer.byteLength(line) + 1;
    if (!this.headClosed && this.headBytes + bytes <= this.headBudget) {
      this.head.push(line);
      this.headBytes += bytes;
      return;
    }
    this.headClosed = true;
    if (bytes > this.tailBudget) {
      const cutAt = Math.max(0, this.tailBudget - 40);
      line = `${utf8Prefix(Buffer.from(line), cutAt).toString('utf8')} [kerb] line cut`;
      bytes = Buffer.byteLength(line) + 1;
      this.truncatedLine = true;
    }
    this.tail.push(line);
    this.tailBytes += bytes;
    while (this.tailBytes > this.tailBudget || this.tail.length - this.tailStart > MAX_TAIL_LINES) {
      const dropped = this.tail[this.tailStart];
      this.tail[this.tailStart] = undefined;
      this.tailStart++;
      this.tailBytes -= Buffer.byteLength(dropped) + 1;
      this.omitted++;
    }
    // Compact the ring now and then so memory stays bounded.
    if (this.tailStart > 4096) {
      this.tail = this.tail.slice(this.tailStart);
      this.tailStart = 0;
    }
  }

  /** @returns {ShapeResult} */
  end() {
    const rest = this.redactor.end();
    if (rest) this.consume(Buffer.from(rest, 'latin1'));
    if (!this.binary) this.addPartial(this.decoder.end());
    if (!this.binary && this.partial.length) this.flushLine(this.takePartial());
    if (!this.binary) this.flushRepeat();
    if (this.logFd !== null) {
      fs.closeSync(this.logFd);
      this.logFd = null;
    }
    let text;
    if (this.binary) {
      text = `[kerb] binary output, ${this.rawBytes} bytes${this.logPath ? ` · log ${this.logPath}` : ''}\n`;
    } else {
      const parts = [...this.head];
      if (this.omitted > 0) parts.push(`[kerb] ${this.omitted} lines omitted${this.logPath ? ` · log ${this.logPath}` : ''}`);
      for (let i = this.tailStart; i < this.tail.length; i++) parts.push(this.tail[i]);
      text = parts.length ? `${parts.join('\n')}\n` : '';
    }
    return {
      text,
      rawBytes: this.rawBytes,
      shownBytes: Buffer.byteLength(text),
      cut: this.binary || this.omitted > 0 || this.truncatedLine,
      omittedLines: this.omitted,
      binary: this.binary,
      totalLines: this.totalLines,
    };
  }
}

/** Shape a whole string at once (hook payloads, tests). */
export function shapeText(text, o = {}) {
  const s = new Shaper(o);
  s.push(Buffer.from(text, 'utf8'));
  return s.end();
}
