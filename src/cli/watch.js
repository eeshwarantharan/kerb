// kerb watch: live view of runs in this repo (4.11.5). Tails .kerb/runs.jsonl, survives rotation,
// exits on Ctrl-C. With --json it prints one JSON object per event (a stream, one per line).
import fs from 'node:fs';
import path from 'node:path';
import { findRoot } from '../util/repo.js';
import { formatBytes, formatDuration } from '../util/core.js';
import { decodeRecord } from '../store/jsonl.js';
import { paint, LOOP_REASONS } from '../ui/format.js';
import { parseOpts } from './args.js';

export function describe(rec, color) {
  const t = new Date(rec.ts).toISOString().slice(11, 19);
  switch (rec.type) {
    case 'start': return `${t}  start   ${rec.class}  ${rec.key}`;
    case 'end': {
      const res = rec.class_result === 'ok' ? 'ok' : rec.class_result;
      const tint = rec.class_result === 'ok' ? 'green' : rec.class_result === 'failure' ? 'red' : 'yellow';
      return `${t}  ${paint(color, tint, `${(res || '').padEnd(6)}`)}  ${rec.class || ''}  exit ${rec.exit ?? '?'}  ${formatDuration(rec.duration_ms)}  ${formatBytes(rec.shown_bytes || 0)}/${formatBytes(rec.raw_bytes || 0)}  ${rec.key || ''}`;
    }
    case 'refusal': return `${t}  ${paint(color, LOOP_REASONS.has(rec.reason) ? 'cyan' : 'yellow', `kerb: ${rec.reason}`)} · ${rec.summary || ''}  ${rec.key}`;
    case 'wait': return `${t}  wait    ${rec.result} after ${rec.attempts} attempts  ${formatDuration(rec.duration_ms)}  ${rec.key}`;
    case 'learn': return `${t}  learned ${rec.status} wall ${rec.host}`;
    case 'ack': return `${t}  ack     ${rec.key}`;
    case 'reset': return `${t}  reset   ${rec.key || 'all keys'}`;
    default: return `${t}  ${rec.type}`;
  }
}

export default async function watch(ctx, args) {
  const { opts } = parseOpts(args, { interval: 'string' });
  const every = Math.max(50, Number(opts.interval) || 200);
  const { root } = findRoot(ctx.cwd);
  const file = path.join(root, '.kerb', 'runs.jsonl');
  let fd = null;
  let ino = null;
  let pos = 0;
  let carry = '';
  const openCurrent = (fromEnd) => {
    try {
      fd = fs.openSync(file, 'r');
      const st = fs.fstatSync(fd);
      ino = st.ino;
      pos = fromEnd ? st.size : 0;
      carry = '';
    } catch { fd = null; ino = null; pos = 0; }
  };
  const drain = () => {
    if (fd === null) return;
    const buf = Buffer.alloc(64 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n <= 0) break;
      pos += n;
      carry += buf.toString('utf8', 0, n);
    }
    const lines = carry.split('\n');
    carry = lines.pop();
    for (const l of lines) {
      const rec = l ? decodeRecord(l) : null;
      if (!rec) continue;
      if (ctx.json) ctx.out(`${JSON.stringify(rec)}\n`);
      else ctx.out(`${describe(rec, ctx.color.out)}\n`);
    }
  };
  const dir = path.dirname(file);
  const rotatedFiles = () => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.map((n) => /^runs\.(\d+)\.jsonl$/.exec(n)).filter(Boolean)
      .map((m) => ({ n: Number(m[1]), file: path.join(dir, m[0]) }))
      .sort((a, b) => a.n - b.n);
  };
  const inoOf = (f) => { try { return fs.statSync(f).ino; } catch { return null; } };
  const readWhole = (f) => {
    fd = fs.openSync(f, 'r');
    pos = 0;
    carry = '';
    drain();
    fs.closeSync(fd);
    fd = null;
  };
  // Start at the end of the current file; rotated files that exist now are history.
  let consumedN = rotatedFiles().reduce((m, r) => Math.max(m, r.n), 0);
  openCurrent(true);
  if (!ctx.json) ctx.out(`kerb watch · ${file} (Ctrl-C to stop)\n`);
  return new Promise((resolve) => {
    const tick = () => {
      drain();
      let st = null;
      try { st = fs.statSync(file); } catch { /* not there (yet), or between rotations */ }
      if (fd !== null && (!st || st.ino !== ino)) {
        // Our file may have been rotated: finish it, then read anything newer.
        const mine = rotatedFiles().find((r) => inoOf(r.file) === ino);
        if (mine) {
          drain();
          try { fs.closeSync(fd); } catch { /* */ }
          fd = null;
          consumedN = mine.n;
        } else if (!st) return;
      }
      if (fd === null) {
        for (const r of rotatedFiles()) {
          if (r.n <= consumedN) continue;
          readWhole(r.file);
          consumedN = r.n;
        }
        if (st) {
          openCurrent(false);
          drain();
        }
      } else if (st && st.size < pos) {
        pos = 0;
        carry = '';
      }
    };
    const timer = setInterval(tick, every);
    const stop = () => {
      clearInterval(timer);
      if (fd !== null) try { fs.closeSync(fd); } catch { /* */ }
      resolve(0);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
