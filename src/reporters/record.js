// Turning parsed results into records (KERB-V2 5.1): the run's `framework` and `tests_summary`,
// and one `test_result` per test. Check-class runs only; never fails the run.
import fs from 'node:fs';
import { now } from '../util/core.js';
import { parseResults } from './index.js';

const MAX_LOG = 64 * 1024 * 1024;

/**
 * @param {any} prep engine prep
 * @param {{ runId: string, postState: string | null, text?: string | null, logFile?: string,
 *   cwd: string, startedAt?: number }} o
 * @returns {{ fields: { framework: string, tests_summary: any }, recs: any[] } | null}
 */
export function testResults(prep, o) {
  if (prep.cls !== 'check') return null;
  let text = o.text ?? null;
  if (text == null && o.logFile) {
    try { if (fs.statSync(o.logFile).size <= MAX_LOG) text = fs.readFileSync(o.logFile, 'utf8'); } catch { text = null; }
  }
  let parsed = null;
  try {
    parsed = parseResults({ command: prep.command, text: text || '', cwd: o.cwd, root: prep.root, startedAt: o.startedAt });
  } catch { parsed = null; }
  if (!parsed) return { fields: { framework: 'unknown', tests_summary: null }, recs: [] };
  const ts = now();
  return {
    fields: { framework: parsed.framework, tests_summary: parsed.summary },
    recs: parsed.results.map((r) => ({ type: 'test_result', run: o.runId, ts, key: prep.key, state: o.postState, ...r })),
  };
}
