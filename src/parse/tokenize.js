// A small shell tokenizer (4.4): quotes, escapes, operators, redirections, heredocs,
// wrapper stripping, one level of `sh -c`, and `cd` tracking. No dependencies.
import os from 'node:os';
import path from 'node:path';

export class ParseError extends Error {}

/**
 * @typedef {{ t: 'word', v: string, raw: string, quoted: boolean }} WordTok
 * @typedef {{ t: 'op', v: string }} OpTok
 * @typedef {{ t: 'redir', v: string }} RedirTok
 * @typedef {WordTok | OpTok | RedirTok} Tok
 */

const TWO_CHAR_OPS = ['&&', '||', ';;', '|&'];
const REDIR_OPS = ['&>>', '&>', '<<<', '<<-', '>>', '>&', '>|', '<<', '<&', '<>', '>', '<'];

/**
 * Split a shell string into tokens. Throws ParseError on unbalanced quotes or substitutions.
 * @param {string} src
 * @returns {Tok[]}
 */
export function lex(src) {
  /** @type {Tok[]} */
  const tokens = [];
  const n = src.length;
  let i = 0;
  /** @type {{ v: string, raw: string, quoted: boolean } | null} */
  let word = null;
  /** @type {{ delim: string, strip: boolean }[]} */
  const heredocs = [];
  let expectHeredocDelim = null;

  const ensure = () => { if (!word) word = { v: '', raw: '', quoted: false }; };
  const flush = () => {
    if (!word) return;
    if (expectHeredocDelim) {
      heredocs.push({ delim: word.v, strip: expectHeredocDelim === '<<-' });
      expectHeredocDelim = null;
    }
    tokens.push({ t: 'word', ...word });
    word = null;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }
      ensure();
      if (i + 1 >= n) { word.v += '\\'; word.raw += '\\'; i++; continue; }
      word.v += src[i + 1];
      word.raw += src.slice(i, i + 2);
      word.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ParseError('unbalanced single quote');
      ensure();
      word.v += src.slice(i + 1, end);
      word.raw += src.slice(i, end + 1);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      const end = readDouble(src, i);
      ensure();
      word.v += unescapeDouble(src.slice(i + 1, end));
      word.raw += src.slice(i, end + 1);
      word.quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) {
      const end = matchBracket(src, i + 1);
      ensure();
      word.v += src.slice(i, end + 1);
      word.raw += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '`') {
      const end = matchBacktick(src, i);
      ensure();
      word.v += src.slice(i, end + 1);
      word.raw += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); i++; continue; }
    if (c === '#' && !word) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      flush();
      tokens.push({ t: 'op', v: '\n' });
      i++;
      if (heredocs.length) i = skipHeredocs(src, i, heredocs.splice(0));
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      // A word made only of digits right before a redirection is its fd number.
      if (word && !word.quoted && /^\d+$/.test(word.v)) word = null;
      else flush();
      const op = REDIR_OPS.find((o) => src.startsWith(o, i));
      i += op.length;
      tokens.push({ t: 'redir', v: op });
      if (op === '<<' || op === '<<-') expectHeredocDelim = op;
      continue;
    }
    if (c === '&' || c === '|' || c === ';' || c === '(' || c === ')') {
      flush();
      const two = src.slice(i, i + 2);
      const op = TWO_CHAR_OPS.includes(two) ? two : c;
      tokens.push({ t: 'op', v: op });
      i += op.length;
      continue;
    }
    ensure();
    word.v += c;
    word.raw += c;
    i++;
  }
  flush();
  return tokens;
}

function readDouble(src, start) {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') return i;
    if (c === '$' && (src[i + 1] === '(' || src[i + 1] === '{')) { i = matchBracket(src, i + 1) + 1; continue; }
    if (c === '`') { i = matchBacktick(src, i) + 1; continue; }
    i++;
  }
  throw new ParseError('unbalanced double quote');
}

function unescapeDouble(s) {
  return s.replace(/\\([\\"$`\n])/g, (_, ch) => (ch === '\n' ? '' : ch));
}

/** Index of the bracket matching the one at `open` ('(' or '{'), quote-aware. */
function matchBracket(src, open) {
  const o = src[open];
  const cl = o === '(' ? ')' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) throw new ParseError('unbalanced single quote');
      i = end;
      continue;
    }
    if (c === '"') { i = readDouble(src, i); continue; }
    if (c === o) depth++;
    else if (c === cl) {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ParseError(`unbalanced ${o}`);
}

function matchBacktick(src, start) {
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === '`') return i;
  }
  throw new ParseError('unbalanced backtick');
}

function skipHeredocs(src, i, docs) {
  for (const d of docs) {
    for (;;) {
      if (i >= src.length) return i;
      const nl = src.indexOf('\n', i);
      const lineEnd = nl === -1 ? src.length : nl;
      let line = src.slice(i, lineEnd);
      if (d.strip) line = line.replace(/^\t+/, '');
      i = nl === -1 ? src.length : nl + 1;
      if (line === d.delim) break;
    }
  }
  return i;
}

/**
 * @typedef {{
 *   program: string | null,   // first remaining word, as written
 *   name: string | null,      // basename of the program
 *   args: string[],
 *   text: string,             // normalised "program args..." for globs and class matching
 *   cwd: string,              // absolute directory the segment runs in (after cd tracking)
 *   assigns: string[],        // names of stripped VAR=value assignments (including env's)
 *   nohup: boolean,
 *   setsid: boolean,
 *   viaShell: boolean,        // came from unwrapping `sh -c "..."`
 *   opaque?: boolean,
 * }} Segment
 * @typedef {{ raw: string, segments: Segment[], background: boolean, opaque: boolean }} Parsed
 */

/**
 * Parse a command into segments. Never throws: a parse failure yields one opaque segment.
 * @param {string} command
 * @param {{ cwd?: string, home?: string }} [opts]
 * @returns {Parsed}
 */
export function parseCommand(command, { cwd = process.cwd(), home = os.homedir() } = {}) {
  try {
    return parseInner(command, cwd, home, 0);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return {
      raw: command,
      opaque: true,
      background: false,
      segments: [{ program: null, name: null, args: [], text: command.trim(), cwd, assigns: [], nohup: false, setsid: false, viaShell: false, opaque: true }],
    };
  }
}

function parseInner(command, baseCwd, home, depth) {
  const tokens = lex(command);
  /** @type {WordTok[][]} */
  const groups = [];
  let cur = [];
  let skipNext = false;
  let lastOp = null;
  let wordsAfterLastOp = false;
  for (const tok of tokens) {
    if (tok.t === 'redir') { skipNext = true; continue; }
    if (tok.t === 'word') {
      if (skipNext) { skipNext = false; continue; }
      cur.push(tok);
      wordsAfterLastOp = true;
      continue;
    }
    skipNext = false;
    if (cur.length) groups.push(cur);
    cur = [];
    if (tok.v !== '\n') {
      lastOp = tok.v;
      wordsAfterLastOp = false;
    }
  }
  if (cur.length) groups.push(cur);
  const background = lastOp === '&' && !wordsAfterLastOp;

  /** @type {Segment[]} */
  const segments = [];
  let cwd = baseCwd;
  for (const g of groups) {
    const words = g.filter((w) => w.quoted || (w.v !== '{' && w.v !== '}' && w.v !== '!'));
    if (!words.length) continue;
    const seg = simplify(words, cwd);
    if (seg.name && SHELLS.has(seg.name) && depth === 0) {
      const inner = shellCString(seg.args);
      if (inner != null) {
        try {
          const p = parseInner(inner, cwd, home, depth + 1);
          for (const s of p.segments) {
            s.viaShell = true;
            s.assigns = [...seg.assigns, ...s.assigns];
            s.nohup = s.nohup || seg.nohup;
            s.setsid = s.setsid || seg.setsid;
            segments.push(s);
          }
          continue;
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
        }
      }
    }
    segments.push(seg);
    if (seg.name === 'cd' || seg.name === 'pushd') {
      const target = seg.args.find((a) => !a.startsWith('-') || a === '-');
      if (target === undefined) cwd = home;
      else if (target !== '-' && !target.includes('$') && !target.includes('`')) {
        cwd = path.resolve(cwd, target.replace(/^~(?=$|\/)/, home));
      }
    }
  }
  return { raw: command, segments, background, opaque: false };
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** For `bash [opts] -c "<string>"`, return the string; otherwise null. */
function shellCString(args) {
  let seenC = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if ((a.startsWith('-') || a.startsWith('+')) && a.length > 1) {
      if (a.startsWith('--')) continue;
      if (a.slice(1).includes('c')) seenC = true;
      if (a === '-o' || a === '+o' || a === '-O' || a === '+O') i++;
      continue;
    }
    return seenC ? a : null;
  }
  return null;
}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip leading assignments and wrappers, repeatedly (4.4 step 3).
 * @param {WordTok[]} words
 * @param {string} cwd
 * @returns {Segment}
 */
function simplify(words, cwd) {
  let w = words.map((x) => ({ v: x.v, raw: x.raw }));
  const assigns = [];
  let nohup = false;
  let setsid = false;
  for (let guard = 0; guard < 20 && w.length; guard++) {
    // VAR=value assignments.
    let k = 0;
    while (k < w.length && ASSIGN_RE.test(w[k].raw)) {
      assigns.push(w[k].v.slice(0, w[k].v.indexOf('=')));
      k++;
    }
    if (k) { w = w.slice(k); continue; }
    const name = base(w[0].v);
    const strip = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : null;
    if (!strip) break;
    const rest = strip(w.map((x) => x.v), assigns);
    if (rest == null) break;
    if (name === 'nohup') nohup = true;
    if (name === 'setsid') setsid = true;
    w = w.slice(w.length - rest);
  }
  const vals = w.map((x) => x.v);
  const program = vals.length ? vals[0] : null;
  const name = program == null ? null : base(program);
  const args = vals.slice(1);
  return {
    program,
    name,
    args,
    text: [name, ...args].filter((x) => x != null).join(' '),
    cwd,
    assigns,
    nohup,
    setsid,
    viaShell: false,
  };
}

function base(p) {
  const b = p.split(/[\\/]/).pop() || p;
  return b.replace(/\.exe$/i, '');
}

/**
 * Wrapper strippers: given the words (starting with the wrapper), return how many words remain
 * after the wrapper and its options, or null if it isn't acting as a wrapper here.
 * @type {Record<string, (w: string[], assigns: string[]) => number | null>}
 */
const WRAPPERS = {
  sudo: (w) => skipOpts(w, new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']),
    new Set(['--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout'])),
  env: (w, assigns) => {
    let i = 1;
    while (i < w.length) {
      const a = w[i];
      if (a === '--') { i++; break; }
      if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') { i += 2; continue; }
      if (a === '-S' || a === '--split-string') return null;
      if (a.startsWith('-')) { i++; continue; }
      if (ASSIGN_RE.test(a)) { assigns.push(a.slice(0, a.indexOf('='))); i++; continue; }
      break;
    }
    return i < w.length ? w.length - i : null;
  },
  nohup: (w) => (w.length > 1 ? w.length - 1 : null),
  time: (w) => skipOpts(w, new Set(['-f', '-o']), new Set(['--format', '--output'])),
  command: (w) => {
    if (w[1] === '-v' || w[1] === '-V') return null;
    return skipOpts(w, new Set(), new Set());
  },
  exec: (w) => skipOpts(w, new Set(['-a']), new Set()),
  nice: (w) => {
    let i = 1;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-n') i += 2;
      else i++;
    }
    return i < w.length ? w.length - i : null;
  },
  timeout: (w) => {
    let i = 1;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-s' || w[i] === '-k') i += 2;
      else i++;
    }
    i++; // the duration
    return i < w.length ? w.length - i : null;
  },
  setsid: (w) => skipOpts(w, new Set(), new Set()),
};

function skipOpts(w, shortWithValue, longWithValue) {
  let i = 1;
  while (i < w.length) {
    const a = w[i];
    if (a === '--') { i++; break; }
    if (!a.startsWith('-') || a === '-') break;
    if (a.startsWith('--')) {
      i += !a.includes('=') && longWithValue.has(a) ? 2 : 1;
      continue;
    }
    i += shortWithValue.has(a) ? 2 : 1;
  }
  return i < w.length ? w.length - i : null;
}

/**
 * For a git segment, skip git's global options and return the subcommand and its args.
 * @param {Segment} seg
 */
export function gitSub(seg) {
  if (seg.name !== 'git') return null;
  const a = seg.args;
  let i = 0;
  let dir = null;
  while (i < a.length && a[i].startsWith('-')) {
    if (a[i] === '-C') { dir = a[i + 1]; i += 2; continue; }
    if (a[i] === '-c' || a[i] === '--git-dir' || a[i] === '--work-tree' || a[i] === '--namespace') { i += 2; continue; }
    i++;
  }
  if (i >= a.length) return null;
  return { sub: a[i], args: a.slice(i + 1), dir: dir ? path.resolve(seg.cwd, dir) : seg.cwd };
}
