// IA · Instant answers for hermetic commands (KERB-V2 6.3, tests IA1–IA10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, sleep } from './helpers.js';
import { isHermetic } from '../src/insight/cache.js';
import { parseCommand } from '../src/parse/tokenize.js';

/** A repo with fake `tsc` and `./run-tests.sh` whose output and exit code the test controls. */
function setup(policy = null) {
  const files = { 'a.ts': 'x\n', '.gitignore': '*.ignore\n' };
  if (policy) files['kerb.policy.json'] = JSON.stringify(policy);
  // A generous hash budget: on a loaded machine the hook's 300 ms budget can run out, and then it
  // rightly fails open (no answer), which isn't what these tests are about.
  const repo = makeRepo({ git: true, files, config: { hash_budget_ms: 20_000 } });
  const bin = path.join(repo.home, 'bin');
  fs.mkdirSync(bin);
  const out = path.join(repo.home, 'out.txt');
  const code = path.join(repo.home, 'code');
  const script = `#!/bin/sh\necho run >> "${path.join(repo.home, 'ran')}"\ncat "${out}"\nexit $(cat "${code}")\n`;
  fs.writeFileSync(path.join(bin, 'tsc'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(repo.dir, 'run-tests.sh'), script, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  return {
    repo,
    set(text, exit) { fs.writeFileSync(out, `${text}\n`); fs.writeFileSync(code, String(exit)); },
    run(cmd = 'tsc --noEmit', extra = {}) { return repo.kerb(['run', ...(extra.args || []), '--', cmd], { env: { ...env, ...(extra.env || {}) } }); },
    ran() { try { return fs.readFileSync(path.join(repo.home, 'ran'), 'utf8').trim().split('\n').length; } catch { return 0; } },
    env,
  };
}
const TSC_ERR = "a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.";

test('IA1 a static check on an unchanged state → a cached answer, the command does not run', () => {
  const s = setup();
  s.set(TSC_ERR, 2);
  assert.equal(s.run().code, 2);
  const r = s.run();
  assert.equal(r.code, 2, 'the recorded exit code');
  assert.equal(s.ran(), 1, 'ran once');
  assert.match(r.stderr, /^kerb: cached · same files and environment as run \S+ \(just now\)\n {6}result: exit 2 · 1 failing: a\.ts:1 TS2322\n {6}next: nothing changed, so re-running gives the same result; change the code first \(full log: \.kerb\/logs\/\S+\.log\)/);
  const j = s.run('tsc --noEmit', { args: ['--json'] }).json;
  assert.equal(j.refused, true);
  assert.equal(j.reason, 'cached');
});

test('IA2 a changed state → runs; IA3 a changed env stamp → runs', () => {
  const s = setup();
  s.set(TSC_ERR, 2);
  s.run();
  s.repo.write('a.ts', 'y\n');
  s.run();
  assert.equal(s.ran(), 2);
  s.run('tsc --noEmit', { env: { NODE_ENV: 'production' } });
  assert.equal(s.ran(), 3, 'NODE_ENV is in the env stamp');
});

test('IA4 a non-hermetic test command keeps identical_retry', () => {
  const s = setup();
  s.set('FAIL test/a.test.js', 1);
  s.run('./run-tests.sh', { args: ['--class', 'check'] });
  const r = s.run('./run-tests.sh', { args: ['--class', 'check'] });
  assert.equal(r.code, 75);
  assert.match(r.stderr, /^kerb: identical_retry/);
});

test('IA5 policy hermetic_commands opts a test command in', () => {
  const s = setup({ hermetic_commands: ['./run-tests.sh'], check_commands: ['./run-tests.sh'] });
  s.set('FAIL test/a.test.js', 1);
  s.run('./run-tests.sh');
  const r = s.run('./run-tests.sh');
  assert.match(r.stderr, /^kerb: cached/);
  assert.equal(r.code, 1);
  assert.equal(s.ran(), 1);
});

test('IA6 transient, dependency and environment failures are never cached', () => {
  for (const [text, kind] of [['Error: connect ETIMEDOUT 10.0.0.1:443', 'transient'], ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'dependency'], ['error: SELF_SIGNED_CERT_IN_CHAIN', 'environment']]) {
    const s = setup();
    s.set(text, 1);
    s.run();
    const r = s.run();
    assert.doesNotMatch(r.stderr, /kerb: cached/, kind);
  }
});

test('IA7 commands that contact a network host are never hermetic', () => {
  const p = (c) => parseCommand(c, { cwd: '/w' });
  assert.equal(isHermetic(p('tsc --noEmit')), true);
  assert.equal(isHermetic(p('cd web && npx eslint src')), true);
  assert.equal(isHermetic(p('deno check https://deno.land/x/mod.ts')), false);
  assert.equal(isHermetic(p('curl https://example.com/health'), { hermetic_commands: ['curl *'] }), false);
  assert.equal(isHermetic(p('eslint --fix src')), false, 'writes files');
  assert.equal(isHermetic(p('tsc --watch')), false, 'never finishes');
  assert.equal(isHermetic(p('npm test')), false, 'not without opt-in');
  assert.equal(isHermetic(p('tsc && npm run deploy')), false, 'every segment must be hermetic');
});

test('IA8 a run older than cache_ttl → runs', async () => {
  const s = setup({ cache_ttl: '1s' });
  s.set('', 0);
  s.run();
  await sleep(1300);
  assert.doesNotMatch(s.run().stderr, /kerb: cached/);
  assert.equal(s.ran(), 2);
});

test('IA9 a cached success says so', () => {
  const s = setup();
  s.set('Found 0 errors.', 0);
  s.run();
  const r = s.run();
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^kerb: cached · same files and environment as run \S+ \(just now\)\n {6}result: passed\n {6}next: no need to re-run\n$/);
  assert.equal(s.ran(), 1);
});

test('IA10 the cached_answer event is recorded and counted; hooks answer too; shadow only records', () => {
  const s = setup();
  s.set(TSC_ERR, 2);
  s.run();
  s.run();
  const ev = records(s.repo.dir).find((x) => x.type === 'cached_answer');
  assert.equal(ev.key, '.::tsc --noEmit');
  assert.match(ev.state, /^st_/);
  assert.equal(ev.source_run, records(s.repo.dir).find((x) => x.type === 'end').id);
  const m = s.repo.kerb(['report', '--json']).json.measured;
  assert.equal(m.cached_answers, 1);
  assert.match(s.repo.kerb(['report']).stdout, /answered from cache\s+1 \(/);
  assert.match(s.repo.kerb(['recap']).stdout, /answered from cache\s+1/);
  // The pre hook denies with the cached answer, even after a success.
  s.set('', 0);
  s.repo.write('a.ts', 'ok\n');
  s.run();
  const p = { session_id: 'h', transcript_path: '/t', cwd: s.repo.dir, tool_name: 'Bash', tool_input: { command: 'tsc --noEmit' }, tool_use_id: 'c1' };
  const out = JSON.parse(s.repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p), env: s.env }).stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /^kerb: cached · [^\n]+\n {6}result: passed\n {6}next: no need to re-run$/);
  // Shadow mode records would_refuse and runs.
  const sh = setup();
  sh.repo.kerb(['init', '--agent', 'other']);
  sh.set(TSC_ERR, 2);
  sh.run();
  sh.run();
  assert.equal(sh.ran(), 2);
  assert.equal(records(sh.repo.dir).find((x) => x.type === 'would_refuse').reason, 'cached');
});
