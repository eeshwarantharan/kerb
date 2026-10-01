// Clippy (cargo clippy) (KERB-V2 5.4): "error: <message>" (warnings count once denied, as with
// -D warnings) then " --> src/lib.rs:3:5" and the lint name from the help link
// ("…/index.html#needless_return"), "#[deny(clippy::…)]", or "`-D unused-comparisons` implied
// by `-D warnings`" for rustc's own lints. Pseudo-tests `clippy:<file>::clippy::needless_return`.
// Recorded with clippy 0.1.99.
import { lines, repoPath, diagnostics } from './common.js';

export const framework = 'clippy';

export function parse(text, ctx) {
  if (!/clippy::|rust-clippy/.test(text)) return null;
  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.file) items.push({ ...cur, rule: cur.rule || 'error' }); cur = null; };
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^(error|warning)(?:\[(E\d+)\])?: (.*)$/.exec(line))) {
      flush();
      if (m[1] !== 'error' || /^(could not compile|aborting due to)/.test(m[3])) continue;
      cur = { file: null, rule: m[2] || null, location: null, message: m[3] };
      continue;
    }
    if (!cur) continue;
    if (!cur.file && (m = /^\s*--> (\S+?):(\d+):\d+$/.exec(line))) { cur.file = repoPath(m[1], ctx); cur.location = `${cur.file}:${m[2]}`; continue; }
    if ((m = /rust-clippy\/[^#\s]*#([\w]+)/.exec(line))) { cur.rule = `clippy::${m[1]}`; continue; }
    if (!cur.rule && ((m = /#\[(?:deny|warn|forbid)\(([\w:]+)\)\]/.exec(line)) || (m = /`-[DW] ([\w:-]+)` implied by/.exec(line)))) {
      cur.rule = m[1].replace(/-/g, '_');
    }
  }
  flush();
  return items.length ? diagnostics(framework, items) : null;
}
