// Shared test helpers (not a test suite).
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/jsonl.js';

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
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  // Tests put these paths inside bash commands; on Windows, Git Bash reads backslashes as escapes.
  return process.platform === 'win32' ? dir.replace(/\\/g, '/') : dir;
}

/**
 * path.join for paths that go inside shell commands: forward slashes on Windows, where Git Bash
 * reads backslashes as escapes.
 */
export function shPath(...parts) {
  const p = path.join(...parts);
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/** A temp repo with an isolated HOME. `git: true` initialises git with one commit. `config` seeds ~/.kerb/config.json. */
export function makeRepo({ git = false, files = {}, config = null } = {}) {
  const dir = tmpDir('kerb-repo-');
  const home = tmpDir('kerb-home-');
  if (config) {
    fs.mkdirSync(path.join(home, '.kerb'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kerb', 'config.json'), JSON.stringify(config));
  }
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
  try { process.kill(pid, 0); } catch (e) { return e.code === 'EPERM'; }
  // A zombie (finished, not yet collected by its new parent) is dead for our purposes.
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat[stat.lastIndexOf(')') + 2] === 'Z') return false;
    } catch { return false; }
  }
  return true;
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

// ---- A fixture log for the query and MCP tests (KERB-V2 11) ----

export const RECORDS_CMD = 'node --test test/app.test.js';
const CMD = RECORDS_CMD;
const mod = (name, body) => `${body}\nmodule.exports = { ${name} };\n`;
const TEST_FILE = [
  "const { it } = require('node:test');", "const assert = require('node:assert/strict');", "const { logout } = require('../src/session.js');",
  "it('logout clears session', () => { assert.equal(logout({ user: 'a' }).user, null); });",
  "it('always passes', () => {});",
].join('\n');
const GOOD = mod('logout', 'function logout(s) {\n  s.user = null;\n  return s;\n}');
const BAD = (v) => mod('logout', `function logout(s) {\n  s.user = s.user; // ${v}\n  return s;\n}`);

let shared = null;
/** One fixture log (shared by the query and MCP tests) for every query: green, red, green (a fix), red again, plus a finding and a refusal. */
export function recordsFixture() {
  if (shared) return shared;
  const repo = makeRepo({ git: true, config: { worker: 'manual' }, files: { 'src/session.js': GOOD, 'test/app.test.js': `${TEST_FILE}\n` } });
  const run = () => repo.kerb(['run', '--', CMD]);
  run();
  repo.write('src/session.js', BAD('one'));
  run();
  repo.write('src/session.js', GOOD.replace('s.user = null;', 's.user = null; // fixed'));
  run();
  repo.write('src/session.js', BAD('two'));
  run();
  const recs = records(repo.dir);
  const ends = recs.filter((r) => r.type === 'end');
  appendRecords(repo.dir, [
    { type: 'finding', id: '3b2e5a71c0', ts: Date.now(), kind: 'cause', key: ends[3].key, test_id: 'node:test/app.test.js::logout clears session', good_state: ends[2].post_hash, bad_state: ends[3].post_hash,
      culprit_hunks: ['src/session.js#0'], locations: ['src/session.js:2'], hunk_count: 1, probes: 7, confidence: 'confirmed', reason_if_undetermined: null },
    { type: 'refusal', id: 'rf1', ts: Date.now(), key: ends[3].key, reason: 'identical_retry', matched_run: ends[3].id, cmd: CMD, summary: 'same files as a failed run', evidence: 'token=sk-ant-0123456789abcdefghijklmnop at /Users/someone/project', avoided_duration_ms: 10, avoided_output_bytes: 10 },
  ]);
  shared = { repo, ends };
  return shared;
}

/** Append records through Kerb's own store (so they carry a crc). */
function appendRecords(dir, recs) {
  new Store(dir).append(recs);
}
