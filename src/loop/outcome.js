// What a finished run counts as for the loop rules (v1 4.7.5) and the insight engines.
import { maskedExit } from '../parse/identity.js';

/** A finished run that counts as a failure (4.7.5). Environment failures never do (KERB-V2 8.3). */
export function isFailure(r) {
  return r.finished && r.exit != null && r.exit !== 0 && r.class === 'check'
    && r.class_result !== 'policy_denial' && r.class_result !== 'aborted' && r.failure_kind !== 'environment';
}

/**
 * For a command whose exit code doesn't report its check (`npm test | tail`, `npm test || true`):
 * record the check's result instead. A failure when the output shows failing tests or errors,
 * otherwise unknown (exit null), never a pass. The shell's code is kept as shell_exit.
 * @param {any} end the end record (changed in place)
 * @param {boolean} masked
 * @param {{ firstFailLine?: string | null, kind?: string | null }} analysis
 * @param {(s: string) => string} redact
 */
export function applyMask(end, masked, analysis, redact = (s) => s) {
  if (!masked || ['aborted', 'timeout', 'idle', 'policy_denial'].includes(end.class_result)) return end;
  const exit = maskedExit(end.tests_summary);
  end.exit_masked = true;
  end.shell_exit = end.exit;
  end.exit = exit;
  end.class_result = exit === 1 ? 'failure' : 'unknown';
  end.failure_kind = exit === 1 ? (end.failure_kind || analysis.kind || 'ordinary') : null;
  end.first_fail_line = exit === 1 ? (end.first_fail_line || (analysis.firstFailLine ? redact(analysis.firstFailLine) : null)) : null;
  return end;
}

export function isSuccess(r) {
  return r.finished && r.exit === 0 && (r.class_result === 'ok' || r.class_result == null);
}

