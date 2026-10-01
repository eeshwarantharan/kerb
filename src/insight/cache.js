// Instant answers (KERB-V2 6.3): a hermetic check about to run on the same key, state and env
// stamp as a recorded run is answered from that run instead of running again.
// Hermetic means the result depends only on the files and the env stamp: static checks by
// default, test commands only when listed in policy `hermetic_commands`. Never hermetic: runs
// that failed transiently, on a dependency or on the environment; commands that contact a
// network host; runs older than policy `cache_ttl` (default 24 h).
import { commandHosts } from '../parse/hosts.js';
import { classifySegment, compileCheckCommands, asWritten } from '../parse/classify-cmd.js';
import { keyRuns, testsByRun, endTs } from './history.js';
import { formatDuration } from '../util/core.js';

const B = '(?=$|[^A-Za-z0-9_])';
const RUNNER = '(?:(?:npx|bunx|pnpm dlx|pnpm exec|yarn) )?';
export const HERMETIC_DEFAULTS = [
  `^${RUNNER}tsc${B}`,
  `^${RUNNER}eslint${B}`,
  `^${RUNNER}prettier( \\S+)* --check${B}`,
  `^${RUNNER}ruff check${B}`,
  `^(?:python[0-9.]* -m )?mypy${B}`,
  `^go vet${B}`,
  `^cargo (check|clippy)${B}`,
  `^deno (lint|check)${B}`,
].map((s) => new RegExp(s));
/** Flags that make a static check write files or never finish: never cached. */
const UNSAFE_FLAGS = /(^| )(--fix|--fix-dry-run|--watch|-w|--write|--build-watch)( |$|=)/;
export const DEFAULT_TTL_MS = 24 * 3600_000;

/**
 * @param {import('../parse/tokenize.js').Parsed} parsed
 * @param {{ hermetic_commands?: string[] }} policy
 */
export function isHermetic(parsed, policy = {}) {
  if (parsed.opaque || parsed.background) return false;
  const extra = compileCheckCommands(policy.hermetic_commands || []);
  let any = false;
  for (const seg of parsed.segments) {
    if (classifySegment(seg) === 'neutral') continue;
    const text = seg.text;
    if (UNSAFE_FLAGS.test(text)) return false;
    if (!HERMETIC_DEFAULTS.some((re) => re.test(text)) && !extra.some((f) => f(text) || f(asWritten(seg)))) return false;
    any = true;
  }
  if (!any) return false;
  const hosts = commandHosts(parsed, { env: {}, resolveGitRemote: () => null });
  return hosts.length === 0;
}

const NEVER_KINDS = new Set(['transient', 'dependency', 'environment']);

/** "2 failing: src/cart.test.js:42 applies discount; …" from a run's test results. */
function resultLine(run, tests) {
  if (run.exit === 0) {
    const n = run.tests_summary && run.tests_summary.total;
    return `result: passed${n ? ` (${n} test${n === 1 ? '' : 's'})` : ''}`;
  }
  const failing = (tests || []).filter((t) => t.status === 'fail' || t.status === 'error');
  if (failing.length) {
    const name = (t) => { const i = t.test_id.indexOf('::'); return i === -1 ? t.test_id : t.test_id.slice(i + 2); };
    const shown = failing.slice(0, 2).map((t) => `${t.location ? `${t.location} ` : ''}${name(t)}`).join('; ');
    return `result: exit ${run.exit} · ${failing.length} failing: ${shown}${failing.length > 2 ? '; …' : ''}`;
  }
  return `result: exit ${run.exit}${run.first_fail_line ? ` · ${run.first_fail_line}` : ''}`;
}

const ago = (ms) => (ms < 60_000 ? 'just now' : `${formatDuration(ms).replace(/ \d+s$/, '')} ago`);

/**
 * A cached answer for this key and state, or null.
 * @param {{ recs: any[], key: string, state: string, nowTs: number, ttlMs?: number }} o
 * @returns {{ refusal: any, matched: any } | null}
 */
export function cachedAnswer(o) {
  const ttl = o.ttlMs ?? DEFAULT_TTL_MS;
  const runs = keyRuns(o.recs, o.key);
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    if (o.nowTs - endTs(r) > ttl) break;
    if (r.post_hash !== o.state || (r.pre_hash && r.pre_hash !== r.post_hash)) continue;
    if (!['ok', 'failure'].includes(r.class_result) || r.exit == null) continue;
    if (r.exit !== 0 && NEVER_KINDS.has(r.failure_kind)) continue;
    const tests = testsByRun(o.recs).get(r.id) || [];
    const evidence = resultLine(r, tests);
    const next = r.exit === 0
      ? 'no need to re-run'
      : `nothing changed, so re-running gives the same result; change the code first${r.log ? ` (full log: ${r.log})` : ''}`;
    return {
      refusal: {
        reason: 'cached', summary: `same files and environment as run ${r.id} (${ago(o.nowTs - endTs(r))})`, evidence, next,
        exit: r.exit, run: r.id, cached: true, details: { source_run: r.id, state: o.state, exit: r.exit },
      },
      matched: r,
    };
  }
  return null;
}
