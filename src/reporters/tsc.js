// tsc (KERB-V2 5.4): diagnostics as pseudo-tests, `tsc:<file>::TS2322`. Both the plain form
// "src/a.ts(1,7): error TS2322: …" and --pretty "src/a.ts:1:7 - error TS2322: …". Recorded
// with TypeScript 5.
import { lines, repoPath, diagnostics } from './common.js';

export const framework = 'tsc';

export function parse(text, ctx) {
  const items = [];
  for (const line of lines(text, ctx.deadline)) {
    const m = /^(\S.*?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line) || /^(\S.*?):(\d+):\d+ - error (TS\d+): (.*)$/.exec(line);
    if (m) items.push({ file: repoPath(m[1], ctx), rule: m[3], location: `${repoPath(m[1], ctx)}:${m[2]}`, message: m[4] });
  }
  return items.length ? diagnostics(framework, items) : null;
}
