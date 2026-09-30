// Scope (4.7.2): a check command depends on its own package plus root-level shared files.
import fs from 'node:fs';
import path from 'node:path';

export const MANIFESTS = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'deno.json', 'Package.swift'];
const MANIFEST_RE = /\.(csproj|sln)$/;

export const ROOT_SHARED = ['package.json', 'pnpm-workspace.yaml', 'go.work', 'Cargo.toml', 'nx.json', 'turbo.json', 'lerna.json',
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock', 'go.work.sum', 'poetry.lock', 'uv.lock'];

function hasManifest(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return false; }
  return names.some((n) => MANIFESTS.includes(n) || MANIFEST_RE.test(n));
}

/**
 * @typedef {{ whole: boolean, pkgRel: string, pkgRoot: string, shared: string[], sharedGlobs: string[] }} Scope
 */

/**
 * @param {string} root repo root
 * @param {string} cwd the check segment's directory
 * @param {{ hash_scope?: string, shared_paths?: string[] }} policy
 * @returns {Scope}
 */
export function computeScope(root, cwd, policy = {}) {
  const sharedGlobs = (policy.shared_paths || []).filter((s) => typeof s === 'string' && s.trim());
  const whole = { whole: true, pkgRel: '.', pkgRoot: root, shared: [], sharedGlobs: [] };
  if (policy.hash_scope === 'repo') return whole;
  const rel = path.relative(root, cwd);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return whole;
  let dir = cwd;
  let pkgRoot = null;
  while (dir !== root && dir.startsWith(root)) {
    if (hasManifest(dir)) { pkgRoot = dir; break; }
    dir = path.dirname(dir);
  }
  if (!pkgRoot) return whole;
  let rootNames = [];
  try { rootNames = fs.readdirSync(root); } catch { /* none */ }
  const shared = rootNames.filter((n) => ROOT_SHARED.includes(n) || /^tsconfig.*\.json$/.test(n)).sort();
  return {
    whole: false,
    pkgRel: path.relative(root, pkgRoot).split(path.sep).join('/'),
    pkgRoot,
    shared,
    sharedGlobs,
  };
}
