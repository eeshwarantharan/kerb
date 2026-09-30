// Human-only actions (4.7.7): the hook refuses agent commands that would switch Kerb off,
// and the actions themselves need a code typed on the terminal.
import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import { EXIT, KerbError, isWindows } from '../util/core.js';

export const HUMAN_ONLY_SUBCOMMANDS = new Set(['ack', 'reset', 'forget', 'config', 'uninstall']);
const WRAPPING_TOOLS = new Set(['script', 'expect', 'unbuffer']);
const EXPORTERS = new Set(['export', 'declare', 'typeset', 'readonly', 'setenv', 'set']);
const NEXT = 'ask the user to run this in their own terminal';

/** Is this segment an invocation of Kerb? Returns Kerb's own argv, or null. */
export function kerbArgv(seg) {
  if (!seg || !seg.name) return null;
  if (seg.name === 'kerb' || seg.name === 'kerb.js') return seg.args;
  if ((seg.name === 'node' || seg.name === 'npx' || seg.name === 'bunx' || seg.name === 'pnpx') && seg.args.length) {
    const i = seg.args.findIndex((a) => !a.startsWith('-'));
    if (i !== -1 && /(^|[\\/])kerb(\.js)?$/.test(seg.args[i])) return seg.args.slice(i + 1);
  }
  return null;
}

/** Kerb's subcommand from its argv (skipping global flags). */
export function kerbSubcommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd') { i++; continue; }
    if (a.startsWith('-')) continue;
    return { sub: a, rest: argv.slice(i + 1) };
  }
  return { sub: null, rest: [] };
}

/**
 * Refusal for commands only the human may run, or null.
 * @param {import('../parse/tokenize.js').Parsed} parsed
 */
export function humanOnlyRefusal(parsed) {
  const refuse = (summary) => ({
    reason: 'human_only',
    summary,
    evidence: 'human-only: kerb ack, reset, forget, config, uninstall, run --force, and KERB_* variables',
    next: NEXT,
    exit: EXIT.POLICY,
  });
  for (const seg of parsed.segments) {
    const kerbVar = seg.assigns.find((a) => a.startsWith('KERB_'));
    if (kerbVar) return refuse(`setting ${kerbVar} is for the user, not the agent`);
    if (seg.name && EXPORTERS.has(seg.name)) {
      const v = seg.args.find((a) => /^KERB_/.test(a));
      if (v) return refuse(`setting ${v.split('=')[0]} is for the user, not the agent`);
    }
    if (seg.name && WRAPPING_TOOLS.has(seg.name) && seg.args.some((a) => /(^|[\s/\\])kerb(\.js)?(\s|$)/.test(a))) {
      return refuse(`running kerb through ${seg.name} is for the user, not the agent`);
    }
    const argv = kerbArgv(seg);
    if (!argv) continue;
    const { sub, rest } = kerbSubcommand(argv);
    if (sub && HUMAN_ONLY_SUBCOMMANDS.has(sub)) return refuse(`kerb ${sub} is for the user, not the agent`);
    if (sub === 'run' || sub === 'wait-for') {
      const dd = rest.indexOf('--');
      const opts = dd === -1 ? rest : rest.slice(0, dd);
      if (opts.includes('--force')) return refuse(`kerb ${sub} --force is for the user, not the agent`);
    }
  }
  return null;
}

/**
 * Ask the human to type a 4-character code on the terminal (/dev/tty, or CONIN$ on Windows).
 * No terminal, or a wrong code: exit 64 with the human_only message.
 * @param {string} action what the code confirms
 * @param {{ open?: (p: string, flags: string) => number }} [io] injectable for tests
 */
export function requireHuman(action, io = {}) {
  const open = io.open || ((p, flags) => fs.openSync(p, flags));
  const fail = () => new KerbError(EXIT.USAGE, `human_only · ${action} needs a person at a terminal; ${NEXT}`);
  let inFd;
  let outFd;
  try {
    if (isWindows) {
      inFd = open('CONIN$', 'r');
      outFd = open('CONOUT$', 'w');
    } else {
      inFd = open('/dev/tty', 'r+');
      outFd = inFd;
    }
  } catch {
    throw fail();
  }
  try {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
    fs.writeSync(outFd, `kerb: ${action} is a human-only action.\nType ${code} to confirm: `);
    const buf = Buffer.alloc(64);
    let answer = '';
    for (;;) {
      let n;
      try { n = fs.readSync(inFd, buf, 0, buf.length, null); } catch (e) {
        if (e.code === 'EAGAIN') continue;
        throw fail();
      }
      if (n <= 0) break;
      answer += buf.toString('utf8', 0, n);
      if (answer.includes('\n')) break;
    }
    if (answer.trim().toUpperCase() !== code) {
      fs.writeSync(outFd, 'kerb: code did not match; nothing changed.\n');
      throw fail();
    }
    return true;
  } finally {
    try { fs.closeSync(inFd); } catch { /* */ }
    if (outFd !== inFd) try { fs.closeSync(outFd); } catch { /* */ }
  }
}
