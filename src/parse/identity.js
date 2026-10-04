// The run identity (KERB-V2 4.4): which check a command really runs, past the output-only
// wrappers agents add when they re-run it. Measured before this existed: of 26 natural rewordings
// of a failing `npm test` (`| tail -50`, `2>&1`, `; echo $?`, `npm run test`, `cd app && …`),
// the Loopbreaker caught 2, because the key was the command's text.
//
// Conservative by design (prefer low false refusals): a command is reduced only when everything
// besides one core command is known to be output-only. Anything else (`npm install && npm test`,
// a stdin redirect, a background job) keeps its literal key.
//
// It also says when the shell's exit code no longer reports the core command's result
// (`npm test | tail` exits 0 when the tests fail): `masked`. A masked run counts as a failure only
// when its output shows failures, and never as a pass (store/jsonl.js, buildRuns).

/** Commands that only read or reshape output. In-place flags make them something else. */
const FILTERS = new Set(['tail', 'head', 'grep', 'egrep', 'fgrep', 'rg', 'tee', 'cat', 'less', 'more', 'wc', 'sort', 'uniq', 'cut', 'tr', 'sed', 'awk', 'column', 'fold', 'nl', 'ts', 'col']);
const IN_PLACE = (seg) => (seg.name === 'sed' && seg.args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place')))
  || (seg.name === 'sort' && seg.args.some((a) => a === '-o' || a.startsWith('--output')))
  || (seg.name === 'awk' && seg.args.some((a) => a === '-i' || a === 'inplace'));
/** After the command: reporting its status or reading a file back. */
const REPORTERS = new Set(['echo', 'printf', 'true', ':', 'cat', 'tail', 'head', 'grep', 'wc', 'less', 'more']);
const PIPES = new Set(['|', '|&']);

/** Package-script aliases that run the same script. */
function canonicalWords(seg, words) {
  if (!['npm', 'pnpm', 'yarn'].includes(seg.name) || words.length < 2) return words;
  const i = words.length - seg.args.length; // index of the first argument
  const a = seg.args;
  if (seg.name === 'npm' && ['t', 'tst'].includes(a[0])) return [...words.slice(0, i), 'test', ...words.slice(i + 1)];
  if (seg.name === 'pnpm' && a[0] === 't') return [...words.slice(0, i), 'test', ...words.slice(i + 1)];
  if (['run', 'run-script', 'rum', 'urn'].includes(a[0]) && a[1] === 'test') return [...words.slice(0, i), 'test', ...words.slice(i + 2)];
  if (seg.name === 'npm' && ['run-script', 'rum', 'urn'].includes(a[0])) return [...words.slice(0, i), 'run', ...words.slice(i + 1)];
  return words;
}

const isSetup = (seg) => (seg.name === 'cd' || seg.name === 'pushd')
  || (seg.name === 'set' && seg.args.every((a) => /^[-+][a-zA-Z]+$/.test(a) || a === 'pipefail' || a === 'errexit' || a === 'nounset'));
const setsPipefail = (seg) => seg.name === 'set' && seg.args.includes('pipefail');

/**
 * @param {import('./tokenize.js').Parsed} parsed
 * @returns {{ text: string, cwd: string, masked: boolean, reduced: boolean } | null} null: use the command as written
 */
export function runIdentity(parsed) {
  if (!parsed || parsed.opaque || parsed.background) return null;
  const segs = parsed.segments.filter((s) => s.name != null);
  if (!segs.length || segs.length !== parsed.segments.length) return null;
  let i = 0;
  let pipefail = false;
  // Leading `cd dir &&` and `set -o pipefail;`: their effect is in the next segment's cwd and flags.
  while (i < segs.length - 1 && isSetup(segs[i]) && ['&&', ';'].includes(segs[i].op)) {
    if (setsPipefail(segs[i])) pipefail = true;
    i++;
  }
  const core = segs[i];
  if (!core || isSetup(core) || core.stdin || !core.words || !core.words.length) return null;
  let masked = false;
  let j = i + 1;
  let op = core.op;
  // A pipeline of filters after the core.
  while (PIPES.has(op) && j < segs.length) {
    const f = segs[j];
    if (!FILTERS.has(f.name) || IN_PLACE(f) || f.stdin) return null;
    if (!pipefail) masked = true;
    op = f.op;
    j++;
  }
  // Then only status reports and reading output back.
  while (j < segs.length) {
    if (op == null || op === '&') return null;
    const r = segs[j];
    if (!REPORTERS.has(r.name) || r.stdin) return null;
    if (op === ';' || op === '||') masked = true;
    // `X && echo ok`: the echo runs only on success, so a failure still exits with X's code.
    op = r.op;
    j++;
  }
  if (op != null && op !== ';') return null;
  const words = canonicalWords(core, core.words);
  const text = [...(core.assignWords || []), ...words].join(' ');
  return { text, cwd: core.cwd, masked, reduced: segs.length > 1 || words !== core.words };
}

/**
 * The exit code a masked run reports for the loop rules: a failure when its output shows failing
 * tests or errors, otherwise unknown (null). Never a pass: a filter can hide failures.
 * @param {{ failed?: number, errors?: number } | null | undefined} summary
 */
export function maskedExit(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return (Number(summary.failed) > 0 || Number(summary.errors) > 0) ? 1 : null;
}
