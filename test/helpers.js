// Shared test helpers (not a test suite).
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KERB = path.join(ROOT, 'bin', 'kerb.js');
/**
 * Tests can target another build: KERB_TEST_BIN=dist/kerb.cjs (the bundle) or a standalone
 * binary. Read only here, by the tests; Kerb itself never reads it.
 */
export const TEST_BIN = process.env.KERB_TEST_BIN ? path.resolve(ROOT, process.env.KERB_TEST_BIN) : null;
export function kerbArgv(args) {
  if (!TEST_BIN) return [process.execPath, [KERB, ...args]];
  if (TEST_BIN.endsWith('.js') || TEST_BIN.endsWith('.cjs')) return [process.execPath, [TEST_BIN, ...args]];
  return [TEST_BIN, args];
}

/** Make a fresh temp directory. */
export function tmpDir(prefix = 'kerb-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A temp repo with an isolated HOME. `git: true` initialises git with one commit. */
export function makeRepo({ git = false, files = {} } = {}) {
  const dir = tmpDir('kerb-repo-');
  const home = tmpDir('kerb-home-');
  for (const [p, content] of Object.entries(files)) {
    const full = path.join(dir, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: gitEnv(home) });
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('commit', '-q', '--allow-empty', '-m', 'init');
  }
  const env = { ...baseEnv(), HOME: home, USERPROFILE: home };
  return {
    dir,
    home,
    env,
    git: (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', env: gitEnv(home) }).toString(),
    write(p, content) {
      const full = path.join(dir, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    },
    read(p) { return fs.readFileSync(path.join(dir, p), 'utf8'); },
    exists(p) { return fs.existsSync(path.join(dir, p)); },
    kerb(args, opts = {}) { return runKerb(args, { cwd: dir, ...opts, env: { ...env, ...(opts.env || {}) }, envMerged: true }); },
  };
}

function gitEnv(home) {
  return {
    ...baseEnv(),
    HOME: home,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

/** Environment without inherited Kerb, colour or npm settings that would disturb tests. */
export function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('KERB_') || k.startsWith('npm_config_') || k === 'NO_COLOR') continue;
    if (k === 'NODE_TEST_CONTEXT') continue;
    env[k] = v;
  }
  return env;
}

/**
 * Run the CLI synchronously.
 * @returns {{ code: number, stdout: string, stderr: string, json: any }}
 */
export function runKerb(args, { cwd = ROOT, env, input, timeout = 60_000, envMerged = false } = {}) {
  const [cmd, argv] = kerbArgv(args);
  const r = spawnSync(cmd, argv, {
    cwd,
    env: envMerged ? env : { ...baseEnv(), ...(env || {}) },
    input,
    timeout,
    encoding: 'utf8',
    detached: true,
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* not JSON */ }
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, json };
}

/** Run the CLI asynchronously; resolves with code and output. */
export function runKerbAsync(args, { cwd = ROOT, env, detached = true } = {}) {
  const [cmd, argv] = kerbArgv(args);
  const child = spawn(cmd, argv, { cwd, env: env || baseEnv(), detached, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, get stdout() { return stdout; }, get stderr() { return stderr; } }));
  });
  return { child, done };
}

/** Read and parse all records of a repo's runs.jsonl. */
export function records(dir) {
  const f = path.join(dir, '.kerb', 'runs.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** True if a process with this PID exists. */
export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Poll until fn() is truthy or timeout. */
export async function waitFor(fn, timeout = 5000, step = 50) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return fn();
}

/**
 * Run the CLI in-process (for tests that inject a clock or a slow hasher).
 * Sets HOME to the repo's temp home for the duration.
 */
export async function inproc(repo, args, { cwd } = {}) {
  const { main } = await import('../src/cli/main.js');
  let stdout = '';
  let stderr = '';
  const out = { write(s) { stdout += s; return true; }, isTTY: false };
  const err = { write(s) { stderr += s; return true; }, isTTY: false };
  const oldHome = process.env.HOME;
  process.env.HOME = repo.home;
  try {
    const code = await main(args, { stdout: out, stderr: err, cwd: cwd || repo.dir, env: repo.env });
    let json = null;
    try { json = JSON.parse(stdout); } catch { /* not JSON */ }
    return { code, stdout, stderr, json };
  } finally {
    process.env.HOME = oldHome;
  }
}
