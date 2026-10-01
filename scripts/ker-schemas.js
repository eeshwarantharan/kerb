#!/usr/bin/env node
// Source of the Kerb Execution Record (KER) v1 schemas (KERB-V2 5.1). Writes one JSON Schema per
// record type to src/platform/schema/ and the published reference, docs/KER.md. Test EV8 checks
// that both match this file.
//   node scripts/ker-schemas.js [--check]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID_BASE = 'https://github.com/eeshwarantharan/kerb/blob/main/src/platform/schema/';

const str = { type: 'string' };
const strN = { type: ['string', 'null'] };
const int = { type: 'integer' };
const intN = { type: ['integer', 'null'] };
const numN = { type: ['number', 'null'] };
const bool = { type: 'boolean' };
const ts = { type: 'integer', minimum: 0, description: 'milliseconds since the Unix epoch' };
const stateId = { type: 'string', pattern: '^st_[0-9a-f]{16}$' };
const stateIdN = { type: ['string', 'null'], pattern: '^st_[0-9a-f]{16}$' };
const hashN = { type: ['string', 'null'], description: 'a state id (v2) or a v1 workspace hash' };
const failureKind = { type: ['string', 'null'], enum: ['transient', 'dependency', 'environment', 'ordinary', null] };
const classResult = { type: ['string', 'null'], enum: ['ok', 'failure', 'policy_denial', 'timeout', 'idle', 'aborted', null] };
const cls = { type: 'string', enum: ['check', 'query', 'other', 'background'] };
const mode = { type: ['string', 'null'], enum: ['shadow', 'enforce', null] };

/** [name, description, where it comes from, required fields, properties] */
export const TYPES = [
  ['session', 'An agent session, written when its first record arrives.', 'event log',
    ['type', 'id', 'ts'], { type: { const: 'session' }, id: str, ts, agent: strN, tier: strN, started: ts, branch: strN, mode }],
  ['state', 'A kept state: the content of a check command\'s scope plus its environment stamp (4.1, 4.2).', 'event log',
    ['type', 'id', 'ts', 'mode', 'materializable'], { type: { const: 'state' }, id: stateId, ts, mode: { type: 'string', enum: ['git', 'walk'] }, scope: str, snapshot_tree: strN, commit: strN, env_stamp: strN, materializable: bool }],
  ['start', 'A run began (v1 4.9). Joined with its `end` into a `run`.', 'event log',
    ['type', 'id', 'ts', 'key', 'class'], { type: { const: 'start' }, id: str, ts, key: str, class: cls, cmd: str, cwd: str, scope: strN, pre_hash: hashN, env_stamp: strN, kerb_pid: intN, pgid: intN, agent: strN, tier: strN, session: strN, mode }],
  ['end', 'A run finished (v1 4.9).', 'event log',
    ['type', 'id', 'ts'], { type: { const: 'end' }, id: str, ts, exit: intN, signal: strN, duration_ms: numN, post_hash: hashN, fingerprint: strN, failure_kind: failureKind, env_subtype: strN, class_result: classResult, raw_bytes: intN, shown_bytes: intN, first_fail_line: strN, loop_skipped: strN, key: str, class: cls, session: strN, framework: strN, tests_summary: { type: ['object', 'null'] } }],
  ['wait', 'A `kerb wait-for` call: many attempts, counted as one run (v1 4.7.8).', 'event log',
    ['type', 'id', 'ts', 'key', 'attempts', 'result'], { type: { const: 'wait' }, id: str, ts, key: str, attempts: int, duration_ms: numN, result: { type: 'string', enum: ['met', 'gave_up', 'aborted'] }, final_exit: intN, pre_hash: hashN, post_hash: hashN, session: strN }],
  ['run', 'A finished command: a `start` and its `end` (or a `wait`), as `kerb query` and `kerb export` return it.', 'derived',
    ['type', 'id', 'key', 'class'], { type: { const: 'run' }, id: str, session: strN, key: str, class: cls, scope: strN, pre_state: hashN, post_state: hashN, exit: intN, duration_ms: numN, fingerprint: strN, failure_kind: failureKind, class_result: classResult, raw_bytes: intN, shown_bytes: intN, framework: strN, tests_summary: { type: ['object', 'null'], properties: { passed: int, failed: int, skipped: int, errors: int, total: int } } }],
  ['test_result', 'One test (or diagnostic) in a run (5.3, 5.4).', 'event log',
    ['type', 'run', 'test_id', 'status'], { type: { const: 'test_result' }, run: str, test_id: str, status: { type: 'string', enum: ['pass', 'fail', 'skip', 'error'] }, location: strN, message: { type: ['string', 'null'], maxLength: 200 }, duration_ms: numN, key: str, state: hashN }],
  ['refusal', 'Kerb refused a command.', 'event log',
    ['type', 'id', 'ts', 'key', 'reason'], { type: { const: 'refusal' }, id: str, ts, key: str, reason: str, matched_run: strN, avoided_duration_ms: { type: 'number', minimum: 0 }, avoided_output_bytes: { type: 'integer', minimum: 0 } }],
  ['would_refuse', 'In shadow mode: a refusal Kerb recorded instead of making (10.2).', 'event log',
    ['type', 'id', 'ts', 'key', 'reason'], { type: { const: 'would_refuse' }, id: str, ts, key: str, reason: str, matched_run: strN, avoided_duration_ms: { type: 'number', minimum: 0 }, avoided_output_bytes: { type: 'integer', minimum: 0 } }],
  ['cached_answer', 'A check answered from a recorded run on the same state (6.3).', 'event log',
    ['type', 'id', 'ts', 'key', 'state', 'source_run'], { type: { const: 'cached_answer' }, id: str, ts, key: str, state: stateId, source_run: str }],
  ['fix', 'A change that turned a failure green (7.6).', 'event log',
    ['type', 'id', 'fingerprint', 'from_state', 'to_state', 'confidence'], { type: { const: 'fix' }, id: str, ts, fingerprint: str, family: strN, test_ids: { type: 'array', items: str }, from_state: stateId, to_state: stateId, hunks: { type: ['array', 'null'] }, commit: strN, confidence: { type: 'string', enum: ['minimal', 'full diff'] } }],
  ['finding', 'A cause isolated by the worker (8.2).', 'event log',
    ['type', 'id', 'kind', 'test_id', 'confidence'], { type: { const: 'finding' }, id: str, ts, kind: { const: 'cause' }, test_id: str, good_state: stateIdN, bad_state: stateIdN, culprit_hunks: { type: 'array' }, probes: int, confidence: { type: 'string', enum: ['confirmed', 'undetermined'] }, reason_if_undetermined: strN }],
  ['learn', 'A wall learned from a policy denial (v1 4.8.5).', 'event log',
    ['type', 'id', 'ts', 'host', 'status'], { type: { const: 'learn' }, id: str, ts, host: str, status: { type: 'string', enum: ['confirmed', 'suspected'] }, run: strN, session: strN, new: bool }],
  ['boundary', 'A learned boundary entry, as kept in ~/.kerb/learned.jsonl (v1 4.8.5).', 'learned store',
    ['kind', 'pattern', 'status'], { type: { const: 'boundary' }, kind: { const: 'host' }, pattern: str, status: { type: 'string', enum: ['confirmed', 'suspected'] }, first_seen: ts, last_seen: ts, hits: int, keys: { type: 'array' }, evidence_run: strN }],
  ['note', 'Advisory text from Kerb or a plugin.', 'event log',
    ['type', 'id', 'ts', 'source', 'text'], { type: { const: 'note' }, id: str, ts, source: str, text: str, level: { type: 'string', enum: ['info', 'warn'] } }],
  ['ack', 'A human allowed one more run of a key (v1 4.7.7).', 'event log',
    ['type', 'id', 'ts', 'key'], { type: { const: 'ack' }, id: str, ts, key: str, fingerprint: strN }],
  ['reset', 'A human cleared loop state for a key, or all keys (v1 4.7.7).', 'event log',
    ['type', 'id', 'ts'], { type: { const: 'reset' }, id: str, ts, key: strN }],
];

export function schemaFor([name, description, , required, properties]) {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `${ID_BASE}${name}.schema.json`,
    title: `KER v1 ${name}`,
    description: `${description} Readers must ignore fields they don't know; within KER v1 changes are additive only.`,
    type: 'object',
    required,
    properties,
  };
}

export function docsText() {
  const lines = [
    '# Kerb Execution Record (KER) v1',
    '',
    'Kerb records what actually ran in an append-only event log, `.kerb/runs.jsonl` (one JSON object per line, each ending with a `crc` field). This page is the published format ([KERB-V2](KERB-V2.md) 5.1). Memory tools, dashboards and research can read the log directly; `kerb query` and `kerb export` (milestone F) will return the same records.',
    '',
    '**Stability.** Within KER v1, changes are additive only: new record types and new optional fields. Readers must ignore fields and record types they don\'t know. Every record has a `type`. Timestamps (`ts`) are milliseconds since the Unix epoch. State ids look like `st_` and 16 hex digits.',
    '',
    '**Derived files.** `.kerb/index/*.json` are indexes rebuilt from the log at any time (`kerb reindex`); they are not part of the format.',
    '',
    '| Type | Where | What it is |',
    '|---|---|---|',
    ...TYPES.map(([n, d, where]) => `| \`${n}\` | ${where} | ${d} |`),
    '',
  ];
  for (const t of TYPES) {
    lines.push(`## \`${t[0]}\``, '', t[1], '', '```json', JSON.stringify(schemaFor(t), null, 2), '```', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function schemaFiles() {
  const files = Object.fromEntries(TYPES.map((t) => [path.join(ROOT, 'src/platform/schema', `${t[0]}.schema.json`), `${JSON.stringify(schemaFor(t), null, 2)}\n`]));
  // The same schemas as a module, so the standalone binary (which has no src/ on disk) has them.
  const all = Object.fromEntries(TYPES.map((t) => [t[0], schemaFor(t)]));
  files[path.join(ROOT, 'src/platform/schema/index.js')] = `// Generated by scripts/ker-schemas.js; do not edit.\nexport const SCHEMAS = ${JSON.stringify(all, null, 2)};\n`;
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const files = { ...schemaFiles(), [path.join(ROOT, 'docs/KER.md')]: docsText() };
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const [f, text] of Object.entries(files)) {
    const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    if (cur === text) continue;
    stale++;
    if (check) process.stdout.write(`stale: ${path.relative(ROOT, f)}\n`);
    else fs.writeFileSync(f, text);
  }
  process.stdout.write(check ? (stale ? '' : 'schemas and docs are up to date\n') : `wrote ${stale} file${stale === 1 ? '' : 's'}\n`);
  process.exit(check && stale ? 1 : 0);
}
