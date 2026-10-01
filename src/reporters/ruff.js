// Ruff (KERB-V2 5.4): the concise form "lint_me.py:1:8: F401 [*] `os` imported but unused" and
// the full form "F401 [*] `os` imported but unused" + " --> lint_me.py:1:8". Pseudo-tests
// `ruff:<file>::F401`. Recorded with Ruff 0.x.
import { lines, repoPath, diagnostics } from './common.js';

export const framework = 'ruff';

export function parse(text, ctx) {
  if (!/(^|\n)Found \d+ errors?\./.test(text)) return null;
  const items = [];
  let pending = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(\S+?):(\d+):\d+: ([A-Z]+\d+) (?:\[\*\] )?(.*)$/.exec(line))) { items.push({ file: repoPath(m[1], ctx), rule: m[3], location: `${repoPath(m[1], ctx)}:${m[2]}`, message: m[4] }); continue; }
    if ((m = /^([A-Z]+\d+) (?:\[\*\] )?(.*)$/.exec(line))) { pending = { rule: m[1], message: m[2] }; continue; }
    if (pending && (m = /^\s*--> (\S+?):(\d+):\d+$/.exec(line))) {
      const file = repoPath(m[1], ctx);
      items.push({ file, rule: pending.rule, location: `${file}:${m[2]}`, message: pending.message });
      pending = null;
    }
  }
  return items.length ? diagnostics(framework, items) : null;
}
