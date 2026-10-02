// Probes (KERB-V2 8.2): run one command in a worktree whose files are a base state plus a subset
// of the hunks from base to target. Results are cached by the resulting tree id, so a subset
// that comes out the same costs nothing. The working tree is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { sha } from '../loop/hashfile.js';
import { atomicWrite, readJson } from '../util/fsx.js';
import { git } from '../state/snapshot.js';
import { treeHunks, scopeSpecs, patchFromHunks } from '../state/hunks.js';
import { worktreeAt, removeWorktree, DEFAULT_WORKTREE_LINKS } from '../state/materialize.js';
import { supervise } from '../run/supervisor.js';
import { stripAnsi } from '../run/shape.js';
import { parseResults } from '../reporters/index.js';
import { Budget } from './ddmin.js';

const MAX_OUTPUT = 8 * 1024 * 1024;
const DIAGNOSTICS = new Set(['tsc', 'eslint', 'ruff', 'mypy', 'clippy']);

/**
 * A test's status in a probe's parsed output: pass, fail, or missing (it didn't run).
 * Failures-only reporters and diagnostics don't list what passed: absent then means pass.
 */
export function targetStatus(testIds, parsed, exit) {
  // No test results and a failure: the run stopped before the tests (a build or collection error,
  // like Go's unused import when only some hunks are applied). That says nothing about the target
  // test, so it is "didn't run", which ddmin treats as unresolved (found by bench/cause.js).
  if (!parsed || !parsed.results) return exit === 0 ? 'pass' : 'missing';
  // A reporter that lists passing or skipped tests lists every test it ran.
  const listsPasses = parsed.results.some((x) => x.status === 'pass' || x.status === 'skip');
  let all = 'pass';
  for (const id of testIds) {
    const r = parsed.results.find((x) => x.test_id === id);
    let s;
    if (r) s = r.status === 'pass' ? 'pass' : r.status === 'skip' ? 'missing' : 'fail';
    else if (DIAGNOSTICS.has(parsed.framework) || exit === 0 || !listsPasses) s = 'pass';
    else s = 'missing';
    if (s === 'fail') return 'fail';
    if (s === 'missing') all = 'missing';
  }
  return all;
}

export class Bench {
  /**
   * @param {{ root: string, job: any, base: any, target: any, command: string, cwdRel: string,
   *   testIds: string[], env: NodeJS.ProcessEnv, envStamp?: string | null, maxProbes: number,
   *   deadline: number, control?: any, links?: string[] }} o base and target are kept states
   */
  constructor(o) {
    Object.assign(this, o);
    this.probes = 0;
    this.cached = 0;
    this.cache = new Map();
    this.dir = null;
    this.cacheFile = path.join(o.root, '.kerb', 'probe-cache.json');
  }

  /** Worktree at the target state, and the hunks from base to target. */
  setup() {
    const wt = worktreeAt(this.root, this.target.id, `job-${this.job.id}`, { envStamp: this.envStamp ?? null, links: this.links });
    if (!wt.ok) return { ok: false, reason: wt.reason };
    this.dir = wt.dir;
    this.diff = treeHunks(this.root, this.base.tree, this.target.tree, scopeSpecs(this.target));
    if (!this.diff) return { ok: false, reason: 'could not diff the two states' };
    return { ok: true, hunks: this.diff.hunks.map((h) => h.id) };
  }

  /** Make the worktree the base state plus `subset`; false when the subset doesn't apply. */
  apply(subset) {
    const links = (this.links || DEFAULT_WORKTREE_LINKS).flatMap((l) => ['-e', l]);
    git(this.dir, ['reset', '-q', '--hard', this.base.commit]);
    git(this.dir, ['clean', '-fdq', ...links]);
    if (!subset.length) return true;
    const patch = patchFromHunks(this.root, this.diff, new Set(subset), { fromTree: this.base.tree, toTree: this.target.tree });
    if (!patch) return true;
    const r = git(this.dir, ['apply', '--whitespace=nowarn', '-'], { input: patch, encoding: 'utf8' });
    return r.status === 0;
  }

  treeId() {
    git(this.dir, ['add', '-A']);
    const r = git(this.dir, ['write-tree'], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
  }

  persistentGet(key) { const c = readJson(this.cacheFile, {}) || {}; return c[key] || null; }
  persistentPut(key, v) {
    const c = readJson(this.cacheFile, {}) || {};
    c[key] = v;
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete c[k];
    try { atomicWrite(this.cacheFile, JSON.stringify(c)); } catch { /* a cache */ }
  }

  /**
   * Run the command on base + subset. fresh: run even if this tree's result is cached (to check
   * that a failure reproduces).
   * @returns {Promise<'pass'|'fail'|'unresolved'>}
   */
  async probe(subset, { fresh = false } = {}) {
    if (!this.apply(subset)) return 'unresolved';
    const tree = this.treeId();
    const key = tree ? sha(this.testIds.join('\n'), this.command, tree) : null;
    if (!fresh && key) {
      const hit = this.cache.get(key) || this.persistentGet(key);
      if (hit) { this.cached++; return hit; }
    }
    if (this.probes >= this.maxProbes || Date.now() >= this.deadline) throw new Budget(null);
    if (this.stopping && this.stopping()) throw new Error('stopped');
    this.probes++;
    const cwd = path.join(this.dir, this.cwdRel && this.cwdRel !== '.' ? this.cwdRel : '');
    const chunks = [];
    let size = 0;
    const sup = supervise(this.command, {
      cwd, env: this.env, timeoutMs: Math.max(1000, this.deadline - Date.now()), idleMs: 120_000,
      onData: (d) => { if (size < MAX_OUTPUT) { chunks.push(d); size += d.length; } },
    });
    if (this.control) this.control.abort = () => sup.abort('SIGTERM');
    const t0 = Date.now();
    const res = await sup.done;
    if (this.control) this.control.probeMs = (this.control.probeMs || 0) + (Date.now() - t0);
    if (res.reason === 'aborted') throw new Error('stopped');
    if (res.reason === 'timeout' || res.reason === 'idle') return 'unresolved';
    const text = stripAnsi(Buffer.concat(chunks).toString('utf8'));
    const parsed = parseResults({ command: this.command, text, cwd, root: this.dir });
    const st = targetStatus(this.testIds, parsed, res.exit);
    const out = st === 'missing' ? 'unresolved' : st;
    if (key && out !== 'unresolved') { this.cache.set(key, out); this.persistentPut(key, out); }
    return out;
  }

  cleanup() {
    if (this.dir && fs.existsSync(this.dir)) removeWorktree(this.root, this.dir);
  }
}
