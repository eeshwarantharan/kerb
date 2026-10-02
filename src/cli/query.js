// kerb query <runs|tests|verification|progress|fixes|findings|states> [filters]: read-only answers
// from the records, as JSON (KERB-V2 11.1). The shapes are published in docs/KER.md.
import { UsageError, parseDuration } from '../util/core.js';
import { openQuery, QUERY_NAMES } from '../platform/query.js';
import { parseOpts } from './args.js';

const USAGE = `usage: kerb query runs [--key K] [--since 2h] [--state st_…] [--status failure|success] [--limit N]
       kerb query tests [--status failing|flaky|passing|skipped] [--test T] [--key K] [--since 2h]
       kerb query verification
       kerb query progress [--key K]
       kerb query fixes [--fingerprint F | --test T] [--key K]
       kerb query findings [--test T]
       kerb query states [--key K] [--green]`;

const ALLOWED = {
  runs: ['key', 'since', 'state', 'status', 'limit'],
  tests: ['status', 'test', 'key', 'since', 'limit'],
  verification: [],
  progress: ['key'],
  fixes: ['fingerprint', 'test', 'key', 'limit'],
  findings: ['test', 'limit'],
  states: ['key', 'green', 'limit'],
};
const STATUS = { runs: ['failure', 'success'], tests: ['failing', 'flaky', 'passing', 'skipped'] };

export default async function query(ctx, args) {
  const { opts, positionals } = parseOpts(args, { key: 'string', since: 'string', state: 'string', status: 'string', test: 'string', fingerprint: 'string', green: 'bool', limit: 'string' });
  const [what, ...extra] = positionals;
  if (!what || extra.length || !QUERY_NAMES.includes(what)) throw new UsageError(USAGE);
  for (const k of Object.keys(opts)) if (!ALLOWED[what].includes(k)) throw new UsageError(`kerb query ${what} takes no --${k}\n${USAGE}`);
  if (opts.status && !STATUS[what].includes(opts.status)) throw new UsageError(`--status is one of ${STATUS[what].join(', ')}`);
  const a = { ...opts };
  if (opts.since) { a.since = parseDuration(opts.since); if (!a.since) throw new UsageError(`--since takes a duration like 2h or 7d (got ${opts.since})`); }
  if (opts.limit) { a.limit = Number(opts.limit); if (!Number.isInteger(a.limit) || a.limit < 1) throw new UsageError('--limit takes a positive whole number'); }
  const q = openQuery({ cwd: ctx.cwd, env: ctx.env });
  ctx.emitJson(q[what](a));
  return 0;
}
