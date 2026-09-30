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
};

export const HELP = `kerb ${VERSION} · keeps your coding agent on the road

usage: kerb <command> [options]

running
  run [opts] -- <command>        pre-check, run supervised, shape output, record
  wait-for [opts] -- <command>   poll a command inside one call until a condition holds
  check -- <command>             pre-check only; never runs anything

setup
  init [--agent <name>] [--dry-run] [--refresh]   wire Kerb into detected agents
  uninstall                      remove everything init added (human-only)
  doctor                         check installation and print fixes

looking
  status                         tiers, boundaries, open breakers, recent runs
  why [run-id]                   explain a refusal
  history [-n N] [--key K]       recent runs
  diff <runA> <runB>             files that differ between two runs
  map                            every boundary with source and hits
  report [--since 7d]            measured and estimated savings
  recap                          session recap
  statusline [--segment]         one status line
  card [--week|--session]        shareable SVG and HTML card
  watch                          live view of runs

human-only
  ack [key]  reset [key]  forget <pattern>  config get|set <key> [value]

platform teams
  policy keygen|sign|verify|lint
  export-denials [--since 7d]
  review --denials <file...>

global flags: --json  --cwd <dir>  --no-color  --help  --version
exit codes: child's code, 75 loop refusal, 77 policy refusal, 124 timeout, 125 idle,
            64 usage, 70 internal, 71 state corrupt. Trust the "kerb:" line over the code.
`;

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
    if (ctx.json) ctx.emitJson({ version: VERSION, commands: Object.keys(COMMANDS) });
    else ctx.out(HELP);
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
