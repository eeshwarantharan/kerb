// The per-invocation context passed to every command.
import { colorEnabled } from '../ui/format.js';

/**
 * @param {{ stdout?: any, stderr?: any, stdin?: string, env?: NodeJS.ProcessEnv, cwd?: string, json?: boolean, noColor?: boolean }} o
 */
export function createContext(o) {
  const stdout = o.stdout || process.stdout;
  const stderr = o.stderr || process.stderr;
  const env = o.env || process.env;
  let jsonEmitted = false;
  const ctx = {
    stdout,
    stderr,
    env,
    cwd: o.cwd || process.cwd(),
    stdin: o.stdin,
    json: !!o.json,
    noColor: !!o.noColor,
    color: {
      out: colorEnabled(stdout, env, !!o.noColor),
      err: colorEnabled(stderr, env, !!o.noColor),
    },
    /** @param {string} s */
    out(s) { stdout.write(s); },
    /** @param {string} s */
    err(s) { stderr.write(s); },
    /** Print exactly one JSON object on stdout (global --json contract). */
    emitJson(obj) {
      if (jsonEmitted) return;
      jsonEmitted = true;
      stdout.write(`${JSON.stringify(obj)}\n`);
    },
  };
  return ctx;
}
