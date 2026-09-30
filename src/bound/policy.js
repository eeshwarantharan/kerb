// Policy layers, merge and lint (4.8.1, 4.8.2).
// Layers, strictest first: managed config → org bundle → repo policy → learned.
// Lower layers only add blocks. Lists merge; numeric settings take the higher layer's value.
import fs from 'node:fs';
import path from 'node:path';
import { parseDuration } from '../util/core.js';

export const REPO_POLICY_FILE = 'kerb.policy.json';

export const POLICY_KEYS = new Set([
  'version', 'breaker_threshold', 'retry_cooldown', 'hash_scope', 'shared_paths', 'check_commands',
  'transient_patterns', 'dependency_patterns', 'env_keys', 'env_markers', 'boundaries', 'fixes', '$schema', 'description',
]);
export const BOUNDARY_KINDS = new Set(['host', 'program', 'command', 'git_push']);
const BOUNDARY_KEYS = new Set(['kind', 'pattern', 'alternative', 'why']);
const FIX_KEYS = new Set(['key_contains', 'output_contains', 'hint']);
const PATTERN_LISTS = ['transient_patterns', 'dependency_patterns'];
const STRING_LISTS = ['shared_paths', 'check_commands', 'env_keys', 'env_markers'];
export const MAX_PATTERN_LEN = 200;
export const MAX_PATTERNS = 50;

export const DEFAULT_ENV_KEYS = ['NODE_ENV', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'JAVA_HOME', 'GOFLAGS', 'RUSTFLAGS', 'CI'];

/**
 * Validate a policy object. Returns a list of problems (empty = valid).
 * @param {any} p
 * @returns {{ level: 'error' | 'warning', message: string }[]}
 */
export function lintPolicy(p) {
  const out = [];
  const err = (message) => out.push({ level: 'error', message });
  const warn = (message) => out.push({ level: 'warning', message });
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    err('policy must be a JSON object');
    return out;
  }
  for (const k of Object.keys(p)) if (!POLICY_KEYS.has(k)) warn(`unknown key: ${k}`);
  if (p.version !== undefined && p.version !== 1) err(`unsupported policy version ${p.version} (this Kerb supports version 1)`);
  if (p.breaker_threshold !== undefined && !(Number.isInteger(p.breaker_threshold) && p.breaker_threshold >= 2 && p.breaker_threshold <= 20)) {
    err('breaker_threshold must be an integer from 2 to 20');
  }
  if (p.retry_cooldown !== undefined) {
    try {
      const ms = parseDuration(p.retry_cooldown);
      if (ms < 1000 || ms > 3_600_000) err('retry_cooldown must be between 1s and 1h');
    } catch {
      err(`retry_cooldown is not a duration: ${p.retry_cooldown}`);
    }
  }
  if (p.hash_scope !== undefined && !['package', 'repo'].includes(p.hash_scope)) err('hash_scope must be "package" or "repo"');
  for (const k of STRING_LISTS) {
    if (p[k] === undefined) continue;
    if (!Array.isArray(p[k]) || p[k].some((x) => typeof x !== 'string')) err(`${k} must be a list of strings`);
    else if (p[k].length > MAX_PATTERNS) err(`${k} has ${p[k].length} entries (max ${MAX_PATTERNS})`);
  }
  for (const k of PATTERN_LISTS) {
    if (p[k] === undefined) continue;
    if (!Array.isArray(p[k])) { err(`${k} must be a list of regular expressions`); continue; }
    if (p[k].length > MAX_PATTERNS) err(`${k} has ${p[k].length} patterns (max ${MAX_PATTERNS})`);
    p[k].forEach((re, i) => {
      if (typeof re !== 'string') { err(`${k}[${i}] must be a string`); return; }
      if (re.length > MAX_PATTERN_LEN) err(`${k}[${i}] is ${re.length} characters (max ${MAX_PATTERN_LEN})`);
      try { new RegExp(re); } catch (e) { err(`${k}[${i}] is not a valid regular expression: ${e.message}`); }
    });
  }
  if (p.boundaries !== undefined) {
    if (!Array.isArray(p.boundaries)) err('boundaries must be a list');
    else {
      p.boundaries.forEach((b, i) => {
        if (!b || typeof b !== 'object') { err(`boundaries[${i}] must be an object`); return; }
        for (const k of Object.keys(b)) if (!BOUNDARY_KEYS.has(k)) warn(`boundaries[${i}]: unknown key ${k}`);
        if (!BOUNDARY_KINDS.has(b.kind)) err(`boundaries[${i}]: kind must be one of ${[...BOUNDARY_KINDS].join(', ')} (got ${JSON.stringify(b.kind)})`);
        if (typeof b.pattern !== 'string' || !b.pattern.trim()) err(`boundaries[${i}]: pattern must be a non-empty string`);
        else if (b.pattern.length > MAX_PATTERN_LEN) err(`boundaries[${i}]: pattern too long`);
        if (b.alternative !== undefined && typeof b.alternative !== 'string') err(`boundaries[${i}]: alternative must be a string`);
        if (b.why !== undefined && typeof b.why !== 'string') err(`boundaries[${i}]: why must be a string`);
      });
    }
  }
  if (p.fixes !== undefined) {
    if (!Array.isArray(p.fixes)) err('fixes must be a list');
    else {
      p.fixes.forEach((f, i) => {
        if (!f || typeof f !== 'object') { err(`fixes[${i}] must be an object`); return; }
        for (const k of Object.keys(f)) if (!FIX_KEYS.has(k)) warn(`fixes[${i}]: unknown key ${k}`);
        if (typeof f.hint !== 'string' || !f.hint) err(`fixes[${i}]: hint is required`);
        if (f.key_contains === undefined && f.output_contains === undefined) err(`fixes[${i}]: needs key_contains or output_contains`);
      });
    }
  }
  return out;
}

/** Read the repo policy; returns { policy, problems, path } or null if absent. */
export function readRepoPolicy(root) {
  const file = path.join(root, REPO_POLICY_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const policy = JSON.parse(text);
    return { policy, problems: lintPolicy(policy), path: file };
  } catch (e) {
    return { policy: {}, problems: [{ level: 'error', message: `invalid JSON: ${e.message}` }], path: file };
  }
}

/**
 * @typedef {{ kind: string, pattern: string, alternative?: string | null, why?: string,
 *   layer: 'org' | 'repo' | 'learned', source: string, status?: string, entry?: any }} Boundary
 * @typedef {{ name: 'org' | 'repo' | 'learned', version?: any, policy: any, source: string, stale?: boolean }} Layer
 */

/**
 * Merge layers (strictest first) into the effective policy.
 * @param {Layer[]} layers
 * @param {{ lockRepoAlternatives?: boolean }} [o]
 */
export function mergeLayers(layers, { lockRepoAlternatives = false } = {}) {
  const merged = {
    breaker_threshold: 3,
    retry_cooldown_ms: 60_000,
    hash_scope: 'package',
    shared_paths: [],
    check_commands: [],
    transient_patterns: [],
    dependency_patterns: [],
    env_keys: [...DEFAULT_ENV_KEYS],
    env_markers: [],
    /** @type {Boundary[]} */
    boundaries: [],
    fixes: [],
    layers: layers.map((l) => ({ name: l.name, version: l.version ?? null, source: l.source, stale: !!l.stale })),
  };
  const numericSet = new Set();
  for (const layer of layers) {
    const p = layer.policy || {};
    // Numeric settings: the first (highest) layer that sets one wins.
    if (!numericSet.has('breaker_threshold') && Number.isInteger(p.breaker_threshold)) {
      merged.breaker_threshold = p.breaker_threshold;
      numericSet.add('breaker_threshold');
    }
    if (!numericSet.has('retry_cooldown') && p.retry_cooldown !== undefined) {
      try {
        merged.retry_cooldown_ms = parseDuration(p.retry_cooldown);
        numericSet.add('retry_cooldown');
      } catch { /* lint reports it */ }
    }
    if (!numericSet.has('hash_scope') && (p.hash_scope === 'repo' || p.hash_scope === 'package')) {
      merged.hash_scope = p.hash_scope;
      numericSet.add('hash_scope');
    }
    for (const k of ['shared_paths', 'check_commands', 'transient_patterns', 'dependency_patterns', 'env_keys', 'env_markers']) {
      if (Array.isArray(p[k])) for (const v of p[k]) if (typeof v === 'string' && !merged[k].includes(v)) merged[k].push(v);
    }
    if (Array.isArray(p.boundaries)) {
      for (const b of p.boundaries) {
        if (!b || !BOUNDARY_KINDS.has(b.kind) || typeof b.pattern !== 'string' || !b.pattern.trim()) continue;
        let alternative = typeof b.alternative === 'string' && b.alternative ? b.alternative : null;
        if (layer.name === 'repo' && lockRepoAlternatives) alternative = null;
        if (layer.name === 'learned') alternative = null;
        const existing = merged.boundaries.find((x) => x.kind === b.kind && x.pattern.toLowerCase() === b.pattern.toLowerCase());
        // A lower layer can't change or loosen a higher layer's block.
        if (existing) continue;
        merged.boundaries.push({
          kind: b.kind,
          pattern: b.pattern.trim(),
          alternative,
          why: typeof b.why === 'string' ? b.why : '',
          layer: layer.name,
          source: layer.source,
          status: b.status,
          entry: b.entry,
        });
      }
    }
    if (Array.isArray(p.fixes)) {
      for (const f of p.fixes) if (f && typeof f.hint === 'string') merged.fixes.push({ ...f, layer: layer.name });
    }
  }
  merged.transient_patterns = merged.transient_patterns.slice(0, MAX_PATTERNS * 3);
  merged.dependency_patterns = merged.dependency_patterns.slice(0, MAX_PATTERNS * 3);
  return merged;
}

/** Human-readable source label for a layer. */
export function layerSource(name, version) {
  if (name === 'org') return `org policy v${version ?? '?'}`;
  if (name === 'repo') return 'repo policy (kerb.policy.json)';
  return 'learned from a policy denial';
}
