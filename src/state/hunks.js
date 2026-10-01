// Hunks of the difference between two states (KERB-V2 7.5, 8.2): `git diff` between two trees,
// limited to a scope, split into hunks. Added, deleted, binary and mode-only files count as one
// hunk each. Hunk ids are "<file>#<n>" (n from 0 within the file); cause findings name culprit
// hunks by these ids, and restore builds patches from a selection of them.
import { git } from './snapshot.js';

/**
 * @typedef {{ id: string, file: string, whole: boolean, header: string, lines: string[] }} Hunk
 * @typedef {{ file: string, head: string[], hunks: Hunk[], whole: boolean }} FileDiff
 */

/** Pathspecs for a state's scope (whole repo when the scope is "."). */
export function scopeSpecs(state) {
  if (!state || !state.scope || state.scope === '.') return [];
  return ['--', state.scope, ...(state.shared || [])];
}

/**
 * Parse unified diff text into files and hunks.
 * @param {string} text
 * @returns {FileDiff[]}
 */
export function parseDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { file: m ? m[2] : line.slice(11), head: [line], hunks: [], whole: false };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      hunk = { id: `${cur.file}#${cur.hunks.length}`, file: cur.file, whole: false, header: line, lines: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk) hunk.lines.push(line);
    else cur.head.push(line);
  }
  for (const f of files) {
    // Drop the empty string after the final newline.
    for (const h of f.hunks) while (h.lines.length && h.lines[h.lines.length - 1] === '') h.lines.pop();
    const created = f.head.some((l) => l.startsWith('new file mode') || l === '--- /dev/null');
    const deleted = f.head.some((l) => l.startsWith('deleted file mode') || l === '+++ /dev/null');
    const binary = f.head.some((l) => l.startsWith('GIT binary patch') || l.startsWith('Binary files'));
    if (created || deleted || binary || !f.hunks.length) {
      f.whole = true;
      f.hunks = [{ id: `${f.file}#0`, file: f.file, whole: true, header: '', lines: [] }];
    }
  }
  return files;
}

/**
 * The diff between two trees, within a scope, as files and hunks.
 * @param {string} root
 * @param {string} fromTree
 * @param {string} toTree
 * @param {string[]} specs pathspecs (with a leading '--'), or []
 * @returns {{ files: FileDiff[], hunks: Hunk[], text: string } | null}
 */
export function treeHunks(root, fromTree, toTree, specs = []) {
  const r = git(root, ['diff', '--no-color', '--no-ext-diff', '--binary', '--full-index', fromTree, toTree, ...specs], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const files = parseDiff(r.stdout);
  return { files, hunks: files.flatMap((f) => f.hunks), text: r.stdout };
}

const RANGE = /^@@ -(\d+(?:,\d+)?) \+(\d+(?:,\d+)?) @@(.*)$/;

/** A hunk applied backwards: the header's ranges and the +/- lines swap. */
export function reverseHunk(h) {
  const m = RANGE.exec(h.header);
  const header = m ? `@@ -${m[2]} +${m[1]} @@${m[3]}` : h.header;
  const lines = h.lines.map((l) => (l.startsWith('+') ? `-${l.slice(1)}` : l.startsWith('-') ? `+${l.slice(1)}` : l));
  // "\ No newline at end of file" follows the line it describes, which keeps its place.
  return { ...h, header, lines };
}

/**
 * A patch from the selected hunks. Whole-file hunks are taken from a fresh diff of that file in
 * the patch's direction, so added and deleted files (and binaries) come out right.
 * @param {string} root
 * @param {{ files: FileDiff[] }} diff from treeHunks(fromTree, toTree)
 * @param {Set<string>} ids hunk ids to include
 * @param {{ reverse?: boolean, fromTree: string, toTree: string }} o
 *   reverse: undo the selected hunks (a patch from toTree's side back towards fromTree)
 */
export function patchFromHunks(root, diff, ids, o) {
  const out = [];
  for (const f of diff.files) {
    const picked = f.hunks.filter((h) => ids.has(h.id));
    if (!picked.length) continue;
    if (f.whole) {
      const [a, b] = o.reverse ? [o.toTree, o.fromTree] : [o.fromTree, o.toTree];
      const r = git(root, ['diff', '--no-color', '--no-ext-diff', '--binary', '--full-index', a, b, '--', f.file], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout) out.push(r.stdout.replace(/\n$/, ''));
      continue;
    }
    let head = f.head;
    if (o.reverse) {
      head = f.head.map((l) => (l.startsWith('--- a/') ? `--- a/${f.file}` : l.startsWith('+++ b/') ? `+++ b/${f.file}` : l))
        .map((l) => { const m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(.*)$/.exec(l); return m ? `index ${m[2]}..${m[1]}${m[3]}` : l; })
        .map((l) => { const m = /^old mode (\d+)$/.exec(l); return m ? `new mode ${m[1]}` : l.replace(/^new mode (\d+)$/, 'old mode $1'); });
    }
    out.push([...head, ...picked.flatMap((h) => { const x = o.reverse ? reverseHunk(h) : h; return [x.header, ...x.lines]; })].join('\n'));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
