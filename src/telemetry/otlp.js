// OTLP/HTTP JSON telemetry (4.14.5), off by default. At session end, one batch of metrics:
// runs, refusals by reason, bytes trimmed, polls folded, walls learned, hash-budget skips.
// Never commands, output, file paths or usernames unless the managed config sets
// telemetry.include_commands. This file and bound/org.js are the only network code paths.
import path from 'node:path';
import { now } from '../util/core.js';
import { loadConfig } from '../config.js';
import { Store } from '../store/jsonl.js';
import { loadSummary } from '../store/summary.js';
import { machineId } from '../bound/review.js';
import { VERSION } from '../version.js';

const TIMEOUT_MS = 2000;

/** Endpoint and switches from the managed and user config. */
export function telemetrySettings(cfg = loadConfig()) {
  const m = (cfg.managed && cfg.managed.telemetry) || {};
  const endpoint = m.otlp_endpoint || cfg.values['telemetry.otlp_endpoint'] || null;
  return {
    endpoint,
    enabled: !!endpoint && cfg.values.telemetry === 'on',
    includeCommands: m.include_commands === true,
  };
}

function metricsUrl(endpoint) {
  return /\/v1\/metrics\/?$/.test(endpoint) ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/metrics`;
}

const attr = (key, v) => ({ key, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: String(v) } });

function sum(name, unit, points) {
  return { name, unit, sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: points } };
}

/**
 * Build the OTLP metrics payload for one session.
 * @param {{ session: any, sessionId: string, recs: any[], includeCommands: boolean, nowTs: number }} o
 */
export function buildPayload(o) {
  const c = o.session.counters;
  const start = `${BigInt(Math.floor(o.session.started || o.nowTs)) * 1_000_000n}`;
  const end = `${BigInt(Math.floor(o.nowTs)) * 1_000_000n}`;
  const point = (value, attributes = []) => ({ asInt: String(value), startTimeUnixNano: start, timeUnixNano: end, attributes });
  const common = [attr('kerb.agent', o.session.agent || 'none'), attr('kerb.tier', o.session.tier || 'none')];
  const reasons = Object.entries(c.by_reason || {}).map(([r, n]) => point(n, [...common, attr('kerb.reason', r)]));
  const walls = new Map();
  for (const r of o.recs) {
    if (r.type !== 'learn' || r.session !== o.sessionId) continue;
    const k = `${r.host}\0${r.status}`;
    walls.set(k, (walls.get(k) || 0) + 1);
  }
  const wallPoints = [...walls].map(([k, n]) => {
    const [host, status] = k.split('\0');
    return point(n, [...common, attr('kerb.host', host), attr('kerb.status', status)]);
  });
  const metrics = [
    sum('kerb.runs', '1', [point(c.runs, common)]),
    sum('kerb.refusals', '1', reasons.length ? reasons : [point(0, common)]),
    sum('kerb.reruns_avoided', '1', [point(c.reruns_avoided, common)]),
    sum('kerb.bytes_trimmed', 'By', [point(c.trimmed_bytes, common)]),
    sum('kerb.polls_folded', '1', [point(c.polls_folded, common)]),
    sum('kerb.hangs_killed', '1', [point(c.hangs_killed, common)]),
    sum('kerb.walls_learned', '1', wallPoints.length ? wallPoints : [point(0, common)]),
    sum('kerb.hash_budget_skips', '1', [point(c.loop_skipped, common)]),
  ];
  if (o.includeCommands) {
    const cmds = o.recs.filter((r) => r.type === 'refusal' && r.session === o.sessionId)
      .map((r) => point(1, [...common, attr('kerb.reason', r.reason), attr('kerb.command', r.cmd || '')]));
    if (cmds.length) metrics.push(sum('kerb.refused_commands', '1', cmds));
  }
  return {
    resourceMetrics: [{
      resource: { attributes: [attr('service.name', 'kerb'), attr('service.version', VERSION), attr('kerb.machine', machineId())] },
      scopeMetrics: [{ scope: { name: 'kerb', version: VERSION }, metrics }],
    }],
  };
}

/**
 * Send one batch for the session if telemetry is on and it wasn't sent yet. Failures are
 * dropped silently and counted in summary.json.
 * @returns {Promise<'off' | 'sent' | 'already' | 'failed' | 'no-session'>}
 */
export async function sendSessionTelemetry(root, sessionId, { fetchImpl } = {}) {
  const s = telemetrySettings();
  if (!s.enabled) return 'off';
  const store = new Store(root);
  const summary = loadSummary(path.join(root, '.kerb'));
  const id = sessionId || summary.current_session;
  const session = id && summary.sessions[id];
  if (!session) return 'no-session';
  if ((summary.telemetry_sent || {})[id]) return 'already';
  let recs = [];
  try { recs = store.read(); } catch { recs = []; }
  const body = JSON.stringify(buildPayload({ session, sessionId: id, recs, includeCommands: s.includeCommands, nowTs: now() }));
  let ok = false;
  try {
    const res = await (fetchImpl || globalThis.fetch)(metricsUrl(s.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  store.updateSummary((sum2) => {
    sum2.telemetry_sent = { ...(sum2.telemetry_sent || {}), [id]: now() };
    if (!ok) sum2.telemetry_failures = (sum2.telemetry_failures || 0) + 1;
  });
  return ok ? 'sent' : 'failed';
}
