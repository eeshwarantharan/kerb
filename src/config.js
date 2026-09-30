// User configuration (4.13) and the managed config (4.8.1, 4.8.4).
// ~/.kerb/config.json is set with `kerb config set` (human-only). The managed config's
// `defaults` override user values, and its `locked` list prevents changes.
import path from 'node:path';
import { atomicWrite, homeKerbDir, readJson } from './util/fsx.js';
import { UsageError, parseDuration } from './util/core.js';

/** Known keys, their validators and defaults. */
export const CONFIG_KEYS = {
  recap: { values: ['on', 'off'], default: 'on' },
  statusline: { values: ['on', 'off'], default: 'on' },
  color: { values: ['auto', 'always', 'never'], default: 'auto' },
  budget: { type: 'int', default: 12_000, min: 200 },
  timeout: { type: 'duration', default: '30m' },
  idle: { type: 'duration', default: '10m' },
  hash_budget_ms: { type: 'int', default: null, min: 10 },
  'price.input_per_mtok': { type: 'number', default: null, min: 0 },
  'claude.rewrite': { type: 'bool', default: false },
  telemetry: { values: ['off', 'on'], default: 'off' },
  'telemetry.otlp_endpoint': { type: 'url', default: null },
  log_budget_mb: { type: 'int', default: 200, min: 1 },
};

/** Managed config locations per OS. */
export function managedConfigPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return '/Library/Application Support/Kerb/managed.json';
  if (platform === 'win32') return path.join(env.ProgramData || 'C:\\ProgramData', 'Kerb', 'managed.json');
  return '/etc/kerb/managed.json';
}

let managedOverride = null;
/** Tests only: point at a managed config file (or null to restore the OS path). Not reachable from the CLI. */
export function setManagedConfigPathForTests(p) { managedOverride = p; }

/** The managed config, or null. Written by MDM; never by Kerb. */
export function loadManaged() {
  const file = managedOverride || managedConfigPath();
  const m = readJson(file, null);
  if (!m || typeof m !== 'object') return null;
  return { ...m, _path: file };
}

export function userConfigPath() {
  return path.join(homeKerbDir({ create: false }), 'config.json');
}

/**
 * Effective configuration: defaults ← user ← managed defaults.
 * @returns {{ values: Record<string, any>, locked: Set<string>, managed: any }}
 */
export function loadConfig() {
  const user = readJson(userConfigPath(), {}) || {};
  const managed = loadManaged();
  /** @type {Record<string, any>} */
  const values = {};
  for (const [k, spec] of Object.entries(CONFIG_KEYS)) values[k] = spec.default;
  for (const [k, v] of Object.entries(user)) if (k in CONFIG_KEYS) values[k] = v;
  const mdefaults = (managed && managed.defaults) || {};
  for (const [k, v] of Object.entries(mdefaults)) if (k in CONFIG_KEYS) values[k] = v;
  const locked = new Set(Array.isArray(managed && managed.locked) ? managed.locked : []);
  return { values, locked, managed };
}

/** Validate and coerce a value for a key. */
export function coerce(key, raw) {
  const spec = CONFIG_KEYS[key];
  if (!spec) throw new UsageError(`unknown config key: ${key}. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
  if (spec.values) {
    if (!spec.values.includes(raw)) throw new UsageError(`${key} must be one of: ${spec.values.join(', ')}`);
    return raw;
  }
  if (spec.type === 'bool') {
    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;
    throw new UsageError(`${key} must be true or false`);
  }
  if (spec.type === 'url') {
    if (!/^https?:\/\/\S+$/.test(String(raw))) throw new UsageError(`${key} must be an http(s) URL`);
    return String(raw);
  }
  if (spec.type === 'duration') {
    parseDuration(raw);
    return raw;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || (spec.type === 'int' && !Number.isInteger(n))) throw new UsageError(`${key} must be a number`);
  if (spec.min != null && n < spec.min) throw new UsageError(`${key} must be at least ${spec.min}`);
  return n;
}

/** Set a user config value (callers enforce human-only). Refuses locked keys. */
export function setUserConfig(key, raw) {
  const { locked } = loadConfig();
  if (locked.has(key)) throw new UsageError(`${key} is locked by your organisation's managed config`);
  const value = coerce(key, raw);
  const file = path.join(homeKerbDir(), 'config.json');
  const cur = readJson(file, {}) || {};
  cur[key] = value;
  atomicWrite(file, `${JSON.stringify(cur, null, 2)}\n`);
  return value;
}
