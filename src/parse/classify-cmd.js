// Command classes (4.4): check, query, background, other.
import { gitSub } from './tokenize.js';
import { globToRegExp } from '../util/core.js';

const B = '(?=$|[^A-Za-z0-9_])';
const CHECK_DEFAULTS = [
  `^(npm|pnpm|yarn|bun)( run)? (test|build|lint|typecheck|check)${B}`,
  `^(npx|pnpm dlx) (jest|vitest|mocha|tsc|eslint|prettier( \\S+)* --check)${B}`,
  `^(jest|vitest|mocha|tsc|eslint|pytest|mypy|rspec|phpunit)${B}`,
  `^python[0-9.]* -m (pytest|unittest|mypy)${B}`,
  `^ruff check${B}`,
  `^go (test|build|vet)${B}`,
  `^cargo (test|build|check|clippy)${B}`,
  `^g?make${B}`,
  `^mvnw? (-\\S+ )*(test|verify|package)${B}`,
  `^gradlew? (-\\S+ )*(test|build|check)${B}`,
  `^dotnet (test|build)${B}`,
  `^swift (test|build)${B}`,
  `^bundle exec (rspec|rake)${B}`,
  `^deno (test|lint|check)${B}`,
].map((s) => new RegExp(s));

const QUERY_PROGRAMS = new Set([
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'ls', 'cat', 'head', 'tail', 'wc', 'diff', 'cmp',
  'test', '[', 'which', 'type', 'stat', 'file', 'pwd', 'echo', 'printf', 'sleep', 'jq',
]);
const QUERY_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files']);
// Directory changes don't run anything; they never make a command "stronger".
const NEUTRAL_PROGRAMS = new Set(['cd', 'pushd', 'popd']);

const RANK = { query: 0, other: 1, check: 2, background: 3 };

/**
 * Compile policy `check_commands` globs. A pattern without `*` also matches with extra arguments.
 * @param {string[]} patterns
 */
export function compileCheckCommands(patterns = []) {
  return patterns.map((p) => {
    const re = globToRegExp(p.trim());
    return (text) => re.test(text) || (!p.includes('*') && text.startsWith(`${p.trim()} `));
  });
}

/**
 * @param {import('./tokenize.js').Segment} seg
 * @param {((text: string) => boolean)[]} [extra] compiled policy check_commands
 * @returns {'check' | 'query' | 'other' | 'neutral'}
 */
export function classifySegment(seg, extra = []) {
  if (seg.opaque || !seg.name) return 'other';
  if (NEUTRAL_PROGRAMS.has(seg.name)) return 'neutral';
  const text = seg.text;
  if (CHECK_DEFAULTS.some((re) => re.test(text)) || extra.some((f) => f(text))) return 'check';
  if (QUERY_PROGRAMS.has(seg.name)) return 'query';
  if (seg.name === 'command' && (seg.args[0] === '-v' || seg.args[0] === '-V')) return 'query';
  if (seg.name === 'git') {
    const g = gitSub(seg);
    if (g && QUERY_GIT.has(g.sub)) return 'query';
  }
  return 'other';
}

/**
 * The command's class is its strongest segment: background > check > other > query.
 * @param {import('./tokenize.js').Parsed} parsed
 * @param {{ checkCommands?: ((text: string) => boolean)[], background?: boolean }} [opts]
 * @returns {'check' | 'query' | 'other' | 'background'}
 */
export function classifyCommand(parsed, { checkCommands = [], background = false } = {}) {
  if (background || parsed.background || parsed.segments.some((s) => s.nohup || s.setsid)) return 'background';
  let best = 'query';
  for (const seg of parsed.segments) {
    const c = classifySegment(seg, checkCommands);
    if (c === 'neutral') continue;
    if (RANK[c] > RANK[best]) best = c;
  }
  return /** @type {any} */ (best);
}

/** The first check-class segment (its cwd decides the package scope), or null. */
export function checkSegment(parsed, checkCommands = []) {
  return parsed.segments.find((s) => classifySegment(s, checkCommands) === 'check') || null;
}
