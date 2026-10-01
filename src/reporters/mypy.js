// mypy (KERB-V2 5.4): "lint_me.py:6: error: Incompatible types …  [assignment]". Pseudo-tests
// `mypy:<file>::<error code>`. Recorded with mypy 1.x.
import { lines, repoPath, diagnostics } from './common.js';

export const framework = 'mypy';

export function parse(text, ctx) {
  if (!/(^|\n)(Found \d+ errors? in \d+ files?|Success: no issues found)/.test(text)) return null;
  const items = [];
  for (const line of lines(text, ctx.deadline)) {
    const m = /^(\S+?\.pyi?):(\d+)(?::\d+)?: error: (.*?)(?: {2}\[([\w-]+)\])?$/.exec(line);
    if (m) items.push({ file: repoPath(m[1], ctx), rule: m[4] || 'error', location: `${repoPath(m[1], ctx)}:${m[2]}`, message: m[3] });
  }
  return diagnostics(framework, items);
}
