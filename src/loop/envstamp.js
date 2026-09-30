// Env stamp (4.7.3): selected environment variables and dependency markers.
import fs from 'node:fs';
import path from 'node:path';
import { sha } from './hashfile.js';
import { DEFAULT_ENV_KEYS } from '../bound/policy.js';

export const DEFAULT_MARKERS = [
  'node_modules/.package-lock.json', 'node_modules/.modules.yaml', 'node_modules/.yarn-state.yml',
  '.venv/pyvenv.cfg', '.venv/lib', 'vendor/modules.txt', 'target/.rustc_info.json', '.gradle',
];

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{ env_keys?: string[], env_markers?: string[] }} policy
 * @param {string[]} dirs package root and repo root
 */
export function envStamp(env, policy, dirs) {
  const keys = policy.env_keys && policy.env_keys.length ? policy.env_keys : DEFAULT_ENV_KEYS;
  const parts = keys.map((k) => `${k}=${env[k] ?? ''}`);
  const markers = [...DEFAULT_MARKERS, ...(policy.env_markers || [])];
  for (const dir of [...new Set(dirs)]) {
    for (const m of markers) {
      try {
        const st = fs.statSync(path.join(dir, m));
        parts.push(`${dir}:${m}:${st.isDirectory() ? 'd' : st.size}:${st.mtimeMs}`);
      } catch { /* absent */ }
    }
  }
  return sha(...parts).slice(0, 32);
}
