// Hand-written option parser for subcommands.
import { UsageError } from '../util/core.js';

/**
 * Parse options for one subcommand.
 * `spec` maps option names (without dashes) to 'bool' | 'string'. `alias` maps short flags to names.
 * Everything after a bare `--` is returned untouched in `rest` (or null when there is no `--`).
 * @param {string[]} args
 * @param {Record<string, 'bool'|'string'>} spec
 * @param {Record<string, string>} [alias]
 */
export function parseOpts(args, spec, alias = {}) {
  /** @type {Record<string, any>} */
  const opts = {};
  const positionals = [];
  let rest = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest = args.slice(i + 1);
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      let name;
      let value;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        name = eq === -1 ? a.slice(2) : a.slice(2, eq);
        if (eq !== -1) value = a.slice(eq + 1);
      } else {
        name = alias[a.slice(1)] || a.slice(1);
      }
      const kind = spec[name];
      if (!kind) throw new UsageError(`unknown option: ${a}`);
      if (kind === 'bool') {
        if (value !== undefined) throw new UsageError(`option --${name} takes no value`);
        opts[name] = true;
      } else {
        if (value === undefined) {
          if (i + 1 >= args.length) throw new UsageError(`option --${name} needs a value`);
          value = args[++i];
        }
        opts[name] = value;
      }
      continue;
    }
    positionals.push(a);
  }
  return { opts, positionals, rest };
}

/**
 * The command for run / wait-for / check: everything after `--`, joined into one shell string.
 * A single argument is used as-is (it is already a shell string).
 */
export function commandFromRest(rest, name) {
  if (!rest || rest.length === 0) throw new UsageError(`usage: kerb ${name} [options] -- <command>`);
  if (rest.length === 1) return rest[0];
  return rest.map(shellQuoteIfNeeded).join(' ');
}

function shellQuoteIfNeeded(w) {
  if (w === '') return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(w)) return w;
  return `'${w.replace(/'/g, `'\\''`)}'`;
}
