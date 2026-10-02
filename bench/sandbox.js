// Sandboxes for benchmark tasks, shared by the harness (run.js), the task validator and the
// cause benchmark: a fresh git repo per task, the starting commit, and the seeded edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Every sandbox and temp HOME is removed when the process exits, Ctrl-C included, unless it was
// kept (--keep). Large tasks (a 100,000-file monorepo, about 1 GB on disk) run only when asked
// for, and only with room to spare.
const owned = new Set();
const removeAll = () => { for (const d of owned) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } owned.clear(); };
process.on('exit', removeAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { removeAll(); process.exit(128 + os.constants.signals[sig]); });

/** A temp directory removed at exit (or by `release`). */
export function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  owned.add(dir);
  return dir;
}

/** Remove a temp directory now, or (keep) leave it in place past exit. */
export function release(dir, { keep = false } = {}) {
  owned.delete(dir);
  if (!keep) fs.rmSync(dir, { recursive: true, force: true });
}

export const LARGE_TASK_BYTES = 3 * 2 ** 30;

/** Free bytes on the volume holding dir (null if unknown). */
export function freeBytes(dir = os.tmpdir()) {
  try { const s = fs.statfsSync(dir); return s.bavail * s.bsize; } catch { return null; }
}

/**
 * Whether a task may run here: large tasks need `large` and LARGE_TASK_BYTES free; every task
 * needs 1 GB free, so a run stops cleanly before it fills the disk.
 * @returns {string | null} why not, or null
 */
export function spaceProblem(task, { large = false } = {}) {
  if (task.large && !large) return 'a large task (100,000 files): pass --large to run it';
  const free = freeBytes();
  const need = task.large ? LARGE_TASK_BYTES : 2 ** 30;
  if (free != null && free < need) return `only ${(free / 2 ** 30).toFixed(1)} GB free in ${os.tmpdir()}, ${need / 2 ** 30} GB needed`;
  return null;
}

const GIT_ENV ={ GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com', GIT_CONFIG_NOSYSTEM: '1' };

/** Which `needs` this machine can meet without outside services. */
export function available(env = process.env) {
  const has = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', env }).status === 0;
  return new Set([
    ...(has('python3', ['--version']) ? ['python'] : []),
    ...(has('go', ['version']) ? ['go'] : []),
    ...(has('python3', ['-m', 'pytest', '--version']) ? ['pytest'] : []),
  ]);
}

/**
 * A task's repo: setup, the starting commit; `edits` (seeded regressions) are left for the caller.
 * @returns {{ dir: string, git: (...a: string[]) => string, sh: (cmd: string, o?: any) => { code: number | null, out: string } }}
 */
export function sandbox(task, ctx = {}, env = process.env) {
  const why = spaceProblem(task, { large: true });
  if (why) throw new Error(`${task.id}: ${why}`);
  const dir = tempDir(`kerb-bench-${task.id}-`);
  task.setup(dir, ctx);
  const genv = { ...env, ...GIT_ENV };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env: genv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'task');
  const sh = (cmd, o = {}) => {
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: dir, env: { ...genv, ...(o.env || {}) }, encoding: 'utf8', timeout: o.timeout || 5 * 60_000, maxBuffer: 1 << 26 });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  return { dir, git, sh };
}

/**
 * Prove a task is sound: for seeded regressions the starting point passes and the edits break it;
 * the check fails as given; the reference solution makes it pass.
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateTask(task, ctx = {}, env = process.env) {
  const problems = [];
  const box = sandbox(task, ctx, env);
  const c = { ...ctx, ...box };
  try {
    if (task.edits) {
      const green = box.sh(task.test, { env: ctx.env });
      if (green.code !== 0) problems.push(`the starting point should pass ${task.test}: ${green.out.slice(-300)}`);
      task.edits(box.dir, c);
    }
    const before = box.sh(task.check, { env: ctx.env });
    if (before.code === 0) problems.push('the check passes before any fix');
    if (task.solve) {
      task.solve(box.dir, c);
      const after = box.sh(task.check, { env: ctx.env });
      if (after.code !== 0) problems.push(`the reference solution doesn't pass the check: ${after.out.slice(-400)}`);
    }
  } finally {
    release(box.dir);
  }
  return { ok: !problems.length, problems };
}
