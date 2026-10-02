// Sandboxes for benchmark tasks, shared by the harness (run.js), the task validator and the
// cause benchmark: a fresh git repo per task, the starting commit, and the seeded edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const GIT_ENV = { GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'bench@example.com', GIT_CONFIG_NOSYSTEM: '1' };

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(ctx.tmp || os.tmpdir(), `kerb-bench-${task.id}-`)));
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
    fs.rmSync(box.dir, { recursive: true, force: true });
  }
  return { ok: !problems.length, problems };
}
