// Entry point: global flags, command dispatch, error-to-exit-code mapping.
import path from 'node:path';
import { EXIT, KerbError, UsageError } from '../util/core.js';
import { logError } from '../util/fsx.js';
import { VERSION } from '../version.js';
import { createContext } from './context.js';

/** Command name → lazy loader. Lazy imports keep `kerb check` and hooks fast. */
export const COMMANDS = {
  run: () => import('./run.js'),
  'wait-for': () => import('./wait-for.js'),
  check: () => import('./check.js'),
  init: () => import('./init.js'),
  uninstall: () => import('./uninstall.js'),
  doctor: () => import('./doctor.js'),
  status: () => import('./status.js'),
  why: () => import('./why.js'),
  history: () => import('./history.js'),
  diff: () => import('./diff.js'),
  map: () => import('./map.js'),
  report: () => import('./report.js'),
  recap: () => import('./recap.js'),
  statusline: () => import('./statusline.js'),
  card: () => import('./card.js'),
  watch: () => import('./watch.js'),
  ack: () => import('./ack.js'),
  reset: () => import('./reset.js'),
  forget: () => import('./forget.js'),
  policy: () => import('./policy.js'),
  'export-denials': () => import('./export-denials.js'),
  review: () => import('./review.js'),
  hook: () => import('./hook.js'),
  config: () => import('./config.js'),
  mode: () => import('./mode.js'),
  enforce: () => import('./enforce.js'),
  'review-shadow': () => import('./review-shadow.js'),
  scan: () => import('./scan.js'),
  gc: () => import('./gc.js'),
  reindex: () => import('./reindex.js'),
  progress: () => import('./progress.js'),
  ledger: () => import('./ledger.js'),
  green: () => import('./green.js'),
  restore: () => import('./restore.js'),
  worker: () => import('./worker.js'),
  jobs: () => import('./jobs.js'),
  show: () => import('./show.js'),
  sync: () => import('./sync.js'),
  query: () => import('./query.js'),
  export: () => import('./export.js'),
  mcp: () => import('./mcp.js'),
  plugins: () => import('./plugins.js'),
  cause: () => import('./cause.js'),
};

/** The six commands `kerb --help` shows (KERB-V2 10.3). */
export const START = [
  ['init [--agent <name>] [--dry-run]', 'wire Kerb into your agents; starts in shadow mode for 7 days'],
  ['scan [--since 30d]', 'see what Kerb would have caught in your past agent sessions'],
  ['status', 'mode, agents, boundaries, open breakers and recent runs'],
  ['report [--since 7d]', 'what Kerb measured, and what it estimates'],
  ['enforce', 'turn blocking on after shadow mode (human-only)'],
  ['doctor [tls]', 'check the installation and print fixes; tls finds your company CA'],
];

/** Everything else, grouped, for `kerb help all`. */
export const GROUPS = [
  ['Look around', [
    ['mode', 'shadow or enforce, and what shadow mode would have stopped'],
    ['review-shadow [--since 7d]', 'each command shadow mode would have stopped, with evidence'],
    ['history [-n N] [--key K]', 'recent runs and refusals'],
    ['map', 'every boundary with source and hits'],
    ['recap', 'the session recap'],
    ['statusline [--segment]', 'one status line'],
    ['card [--week|--session|--scan]', 'shareable SVG and HTML card'],
    ['watch', 'live view of runs'],
  ]],
  ['Insight', [
    ['progress [--key K]', 'failing counts per check key since its last success, and the trend'],
    ['ledger', 'what was tried in the last 24 hours, from the records'],
    ['green [--key K] [--test T]', 'the newest state where a check (or one test) passed'],
    ['restore <state> --patch', 'a patch back to that state (or --keep-except <finding>); applies nothing'],
    ['cause [test]', 'which edit broke a test, confirmed by probes'],
    ['show fix:<id> | f:<id>', 'a proven fix or a cause finding, with its diff'],
    ['sync', 'merge fixes teammates shared through git notes'],
    ['why [run-id]', 'explain a refusal (or a run\'s test results) with its evidence'],
    ['diff <runA> <runB>', 'files that differ between two runs'],
    ['gc [--dry-run]', "apply retention to Kerb's kept states"],
    ['reindex', 'rebuild the indexes in .kerb/index from the event log'],
  ]],
  ['Platform (what agents and hooks call)', [
    ['run [opts] -- <command>', 'pre-check, run supervised, shape output, record'],
    ['wait-for [opts] -- <command>', 'poll a command inside one call until a condition holds'],
    ['check -- <command>', 'pre-check only; never runs anything'],
    ['hook <agent> <event>', 'hook handler for an agent'],
    ['worker [status|stop]', 'the background worker (started on demand)'],
    ['jobs', "the worker's queue"],
    ['query <what> [filters]', 'runs, tests, verification, progress, fixes, findings, states as JSON'],
    ['export [--since 7d] [--no-text]', 'the records as KER NDJSON, redacted'],
    ['mcp', 'the read-only MCP server over stdio (agents start it)'],
  ]],
  ['Platform teams', [
    ['policy keygen|sign|verify|lint', 'sign and check org policy bundles'],
    ['export-denials [--since 7d]', 'learned boundaries, for team review'],
    ['review --denials <file...>', 'turn exported denials into a policy patch'],
    ['plugins [list]', 'listed plugins and whether each loads'],
  ]],
  ['Human-only (each asks for a code typed in your terminal)', [
    ['enforce', 'turn blocking on'],
    ['ack [key]', 'allow one more run of a command after a breaker opened'],
    ['reset [key]', 'clear loop state'],
    ['forget <pattern>', 'remove a learned boundary'],
    ['config get|set <key> [value]', 'user settings (get needs no code)'],
    ['uninstall', 'remove everything init added'],
    ['restore <state> --in-place', 'back up your changes with git stash, then restore the state'],
    ['sync --push', 'push shared fixes (refs/notes/kerb) to origin'],
    ['plugins approve <path>', 'approve a repo-listed plugin at its current hash'],
  ]],
];

const FOOTER = `global flags: --json  --cwd <dir>  --no-color  --help  --version
exit codes: child's code, 75 loop refusal, 77 policy refusal, 124 timeout, 125 idle,
            64 usage, 70 internal, 71 state corrupt. Trust the "kerb:" line over the code.
`;

const WIDTH = Math.max(...[...START, ...GROUPS.flatMap(([, l]) => l)].map(([u]) => u.length));

function rows(list, width) {
  return list.map(([u, d]) => `  ${u.padEnd(width)}  ${d}`).join('\n');
}

export const HELP = `kerb ${VERSION} · keeps your coding agent on the road

usage: kerb <command> [options]

${rows(START, WIDTH)}

more commands: kerb help all
${FOOTER}`;

export const HELP_ALL = `kerb ${VERSION} · all commands

Start here
${rows(START, WIDTH)}
${GROUPS.map(([name, list]) => `\n${name}\n${rows(list, WIDTH)}`).join('\n')}

${FOOTER}`;

/**
 * Split global flags from the rest. Flags after a bare `--` belong to the child command.
 * @param {string[]} argv
 */
export function extractGlobals(argv) {
  const g = { json: false, noColor: false, cwd: null, rest: /** @type {string[]} */ ([]) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      g.rest.push(...argv.slice(i));
      break;
    }
    if (a === '--json') g.json = true;
    else if (a === '--no-color') g.noColor = true;
    else if (a === '--cwd') {
      if (i + 1 >= argv.length) throw new UsageError('option --cwd needs a value');
      g.cwd = argv[++i];
    } else if (a.startsWith('--cwd=')) g.cwd = a.slice(6);
    else g.rest.push(a);
  }
  return g;
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, env?: NodeJS.ProcessEnv, cwd?: string }} [io]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, io = {}) {
  let g;
  try {
    g = extractGlobals(argv);
  } catch (e) {
    (io.stderr || process.stderr).write(`kerb: usage · ${e.message}\n`);
    return EXIT.USAGE;
  }
  const [name, ...args] = g.rest;
  const ctx = createContext({ ...io, json: g.json, noColor: g.noColor, cwd: g.cwd ? path.resolve(io.cwd || process.cwd(), g.cwd) : io.cwd });

  if (!name || name === 'help' || name === '--help' || name === '-h') {
    const all = name === 'help' && args[0] === 'all';
    if (ctx.json) ctx.emitJson({ version: VERSION, start: START.map(([u]) => u.split(' ')[0]), commands: Object.keys(COMMANDS) });
    else ctx.out(all ? HELP_ALL : HELP);
    return 0;
  }
  if (name === '--version' || name === '-v' || name === 'version') {
    if (ctx.json) ctx.emitJson({ version: VERSION });
    else ctx.out(`${VERSION}\n`);
    return 0;
  }
  const loader = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
  if (!loader) {
    return fail(ctx, new UsageError(`unknown command: ${name}. Run kerb --help`));
  }
  try {
    const mod = await loader();
    return await mod.default(ctx, args);
  } catch (e) {
    return fail(ctx, e);
  }
}

function fail(ctx, e) {
  if (e instanceof KerbError) {
    if (ctx.json) ctx.emitJson({ error: e.message, exit: e.code });
    else ctx.err(`kerb: ${e.code === EXIT.USAGE ? 'usage' : 'error'} · ${e.message}\n`);
    return e.code;
  }
  logError('cli', e);
  if (ctx.json) ctx.emitJson({ error: String(e && e.message ? e.message : e), exit: EXIT.INTERNAL });
  else ctx.err(`kerb: error · internal error: ${e && e.message ? e.message : e} (details in ~/.kerb/errors.log)\n`);
  return EXIT.INTERNAL;
}
