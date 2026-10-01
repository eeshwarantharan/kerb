// What a finished run counts as for the loop rules (v1 4.7.5) and the insight engines.

/** A finished run that counts as a failure (4.7.5). Environment failures never do (KERB-V2 8.3). */
export function isFailure(r) {
  return r.finished && r.exit != null && r.exit !== 0 && r.class === 'check'
    && r.class_result !== 'policy_denial' && r.class_result !== 'aborted' && r.failure_kind !== 'environment';
}

export function isSuccess(r) {
  return r.finished && r.exit === 0 && (r.class_result === 'ok' || r.class_result == null);
}

