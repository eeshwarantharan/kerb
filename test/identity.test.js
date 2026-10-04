// The run identity (src/parse/identity.js): the same check, however an agent words it, without
// false refusals; and a filtered run's exit code never counts as a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRepo, runKerb } from './helpers.js';
import { parseCommand } from '../src/parse/tokenize.js';
import { runIdentity, maskedExit } from '../src/parse/identity.js';

const id = (c) => runIdentity(parseCommand(c, { cwd: '/r' }));

test('RI1 output-only wrappers reduce to the core check; masking is detected', () => {
  const same = [
    ['npm test', false], ['npm test 2>&1', false], ['npm test 2>&1 | tail -50', true], ['npm test | head -100', true],
    ['npm test 2>&1 | grep -E "fail|not ok"', true], ['npm test | tee out.txt', true], ['npm test > o.txt 2>&1; cat o.txt', true],
    ['npm test; echo "exit: $?"', true], ['npm test || true', true], ['npm test && echo ok', false], ['time npm test', false],
    ['timeout 120 npm test', false], ['bash -c "npm test"', false], ["sh -c 'npm test'", false], ['(npm test)', false],
    ['(npm test) | tail', true], ['npm run test', false], ['npm t', false], ['npm run-script test', false],
    ['set -o pipefail; npm test | tail', false],
  ];
  for (const [c, masked] of same) {
    const r = id(c);
    assert.ok(r, c);
    assert.equal(r.text, 'npm test', c);
    assert.equal(r.cwd, '/r', c);
    assert.equal(r.masked, masked, `${c}: masked`);
  }
  assert.deepEqual(id('cd app && npm test'), { text: 'npm test', cwd: '/r/app', masked: false, reduced: true });
  assert.equal(id('CI=1 npm test').text, 'CI=1 npm test');
  assert.equal(id('env CI=1 npm test').text, 'CI=1 npm test');
  assert.equal(id('pytest -k "a b"').text, 'pytest -k "a b"', 'quoting kept');
  assert.equal(id('npm run-script lint').text, 'npm run lint');
  // Not reduced: two real commands, stdin, background, in-place edits, a pipe into a program.
  for (const c of ['npm install && npm test', 'npm test < /dev/null', 'npm test &', 'npm test | sed -i s/a/b/ x', 'npm test | node report.js', 'npm test; npm run lint']) {
    assert.equal(id(c), null, c);
  }
});

test('RI2 a masked run fails only on failures in its output, and never passes', () => {
  assert.equal(maskedExit({ passed: 3, failed: 1 }), 1);
  assert.equal(maskedExit({ errors: 2 }), 1);
  assert.equal(maskedExit({ passed: 5, failed: 0 }), null);
  assert.equal(maskedExit(null), null);
});

function failing() {
  return makeRepo({ git: true, config: { mode: 'enforce' }, files: {
    'package.json': JSON.stringify({ name: 'v', type: 'module', scripts: { test: 'node --test' } }),
    'test/a.test.js': "import test from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(1, 2));\n",
    'app/package.json': JSON.stringify({ name: 'app', type: 'module', scripts: { test: 'node --test' } }),
    'app/test/b.test.js': "import test from 'node:test'; import assert from 'node:assert'; test('b', () => assert.equal(1, 2));\n",
  } });
}

function pre(repo, command, cwd = repo.dir) {
  const r = runKerb(['hook', 'claude', 'pre'], { cwd, env: repo.env, envMerged: true,
    input: JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } }) });
  try { return JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny'; } catch { return false; }
}

test('RI3 after a failing npm test with nothing changed, its rewordings are refused', () => {
  const repo = failing();
  assert.equal(repo.kerb(['run', '--', 'npm test']).code, 1);
  for (const c of ['npm test 2>&1 | tail -50', 'npm test; echo "exit: $?"', 'npm test || true', 'bash -c "npm test"', 'npm run test', 'npm t', `cd ${repo.dir} && npm test`]) {
    assert.equal(pre(repo, c), true, c);
  }
  repo.kerb(['run', '--', 'cd app && npm test']);
  assert.equal(pre(repo, 'npm test', `${repo.dir}/app`), true, 'cd app && npm test, then npm test in app');
  const msg = runKerb(['hook', 'claude', 'pre'], { cwd: repo.dir, env: repo.env, envMerged: true,
    input: JSON.stringify({ session_id: 's1', cwd: repo.dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test 2>&1 | tail -50' } }) });
  assert.match(msg.stdout, /same check as `npm test`/);
});

test('RI4 look-alikes that can change the result are still allowed', () => {
  const repo = failing();
  repo.kerb(['run', '--', 'npm test']);
  assert.equal(pre(repo, 'npm test', `${repo.dir}/app`), false, 'another package is another check');
  for (const c of ['CI=1 npm test', 'npm install && npm test', 'node --test test/a.test.js', 'npm test -- --test-reporter=spec', 'node --test', 'npm test < /dev/null']) {
    assert.equal(pre(repo, c), false, c);
  }
  repo.write('test/a.test.js', "import test from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(2, 2));\n");
  assert.equal(pre(repo, 'npm test 2>&1 | tail -50'), false, 'after an edit');
});

test('RI5 a failing suite piped through a filter is never reported green; with pipefail its result counts', () => {
  const repo = failing();
  const status = () => repo.kerb(['status', '--json']).json.verification.find((v) => v.key === '.::npm test');
  assert.equal(repo.kerb(['run', '--', 'npm test 2>&1 | tail -5']).code, 0, 'the agent still sees the shell exit code');
  assert.notEqual(status()?.status, 'green');
  repo.kerb(['run', '--', 'npm test 2>&1 | grep "# pass"']);
  assert.notEqual(status()?.status, 'green', 'a filter that hides failures');
  const red = repo.kerb(['run', '--', 'npm test 2>&1 | tail -30']);
  assert.equal(status().status, 'red', 'failures in the filtered output count (the TAP header was cut off)');
  assert.match(red.stderr, /exit 0 \(from the pipe or what follows; the check failed\)/);
  repo.write('test/a.test.js', "import test from 'node:test'; import assert from 'node:assert'; test('a', () => assert.equal(2, 2));\n");
  repo.write('app/test/b.test.js', "import test from 'node:test'; import assert from 'node:assert'; test('b', () => assert.equal(2, 2));\n");
  repo.kerb(['run', '--', 'npm test | tail -30']);
  assert.notEqual(status().status, 'green', 'a filtered pass is unknown, not green');
  repo.kerb(['run', '--', 'set -o pipefail; npm test | tail -30']);
  assert.equal(status().status, 'green', 'pipefail keeps the exit code');
});

test('RI6 the Boundary Map sees blocked hosts in inline interpreter code', async () => {
  const { explicitHosts } = await import('../src/parse/hosts.js');
  const hosts = (c) => parseCommand(c, { cwd: '/r' }).segments.flatMap((s) => explicitHosts(s).map((h) => h.host));
  assert.deepEqual(hosts(`node -e "fetch('https://registry.npmjs.org/x')"`), ['registry.npmjs.org']);
  assert.deepEqual(hosts(`python3 -c "import urllib.request; urllib.request.urlopen('https://pypi.org/simple')"`), ['pypi.org']);
  assert.deepEqual(hosts(`node --eval="fetch('https://example.com')"`), ['example.com']);
  assert.deepEqual(hosts('node -e "console.log(1)"'), []);
  assert.deepEqual(hosts('node script.js https://example.com'), [], 'a script argument is not inline code');
});
