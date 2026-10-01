// Kerb Execution Record (KER) v1 helpers (KERB-V2 5.1): load the schemas, validate a record,
// and derive `run` records from `start`/`end` pairs and `wait` records.
import { validate } from './validate.js';
import { SCHEMAS } from './schema/index.js';

/** @returns {Record<string, any>} type → schema (the published files, embedded) */
export function schemas() {
  return SCHEMAS;
}

/** Problems with a record, or [] when it is valid. Records of unknown types are accepted. */
export function validateRecord(rec) {
  const s = schemas()[rec && rec.type];
  if (!s) return [];
  const { crc, ...body } = rec;
  void crc;
  return validate(s, body);
}

const stateOrHash = (h) => (h == null ? null : h);

/** A run (from store/jsonl.js buildRuns) as a KER `run` record. */
export function kerRun(r) {
  return {
    type: 'run',
    id: r.id,
    session: r.session ?? null,
    key: r.key,
    class: r.class,
    scope: r.scope ?? null,
    pre_state: stateOrHash(r.pre_hash),
    post_state: stateOrHash(r.post_hash),
    exit: r.is_wait ? r.final_exit ?? null : r.exit ?? null,
    duration_ms: r.duration_ms ?? null,
    fingerprint: r.fingerprint ?? null,
    failure_kind: r.failure_kind ?? null,
    class_result: r.class_result ?? null,
    raw_bytes: r.raw_bytes ?? null,
    shown_bytes: r.shown_bytes ?? null,
    framework: r.framework ?? null,
    tests_summary: r.tests_summary ?? null,
    ts: r.end_ts ?? r.ts,
  };
}
