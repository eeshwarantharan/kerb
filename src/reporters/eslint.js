// ESLint's stylish formatter (KERB-V2 5.4): a file line, then "  1:7  error  message  rule".
// Errors become pseudo-tests `eslint:<file>::<rule>`; warnings don't fail a run and are skipped.
// Recorded with ESLint 9.
import { lines, repoPath, diagnostics } from './common.js';

export const framework = 'eslint';

export function parse(text, ctx) {
  if (!/(^|\n)✖ \d+ problems? \(/.test(text)) return null;
  const items = [];
  let file = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(\/\S.*|[A-Za-z]:\\\S.*|\S+\.\w+)$/.exec(line)) && !line.startsWith(' ')) { file = repoPath(m[1], ctx); continue; }
    if (file && (m = /^\s+(\d+):\d+\s+error\s+(.+?)\s{2,}(\S+)$/.exec(line))) items.push({ file, rule: m[3], location: `${file}:${m[1]}`, message: m[2] });
  }
  return items.length ? diagnostics(framework, items) : null;
}
