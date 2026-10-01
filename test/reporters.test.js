// RP · Reporter parsers (KERB-V2 5.4, tests RP1–RP14), against outputs recorded from the real
// tools (test/fixtures/reporters/README.md says which, and how).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records, ROOT } from './helpers.js';
import { parseResults, hintFor } from '../src/reporters/index.js';
import { runCase } from '../scripts/reporter-goldens.js';

const DIR = path.join(ROOT, 'test/fixtures/reporters');
const CASES = JSON.parse(fs.readFileSync(path.join(DIR, 'cases.json'), 'utf8'));
const golden = (c) => JSON.parse(fs.readFileSync(path.join(DIR, `${c.fixture}.expected.json`), 'utf8'));
const ids = (r, status) => r.results.filter((x) => !status || x.status === status).map((x) => x.test_id).sort();

const NAMES = {
  RP1: 'Vitest', RP2: 'Jest', RP3: 'pytest (text and JUnit XML)', RP4: 'go test', RP5: 'cargo test', RP6: 'Node test runner',
  RP7: 'tsc', RP8: 'ESLint', RP9: 'Ruff', RP10: 'mypy', RP11: 'Clippy',
};
for (const [rp, name] of Object.entries(NAMES)) {
  const cases = CASES.filter((c) => c.rp === rp);
  test(`${rp} ${name}: test ids, statuses, locations and messages`, () => {
    assert.ok(cases.length, `fixtures recorded for ${name}`);
    for (const c of cases) {
      const r = runCase(c);
      assert.ok(r, `${c.fixture} recognised`);
      assert.deepEqual(r, golden(c), c.fixture);
      for (const x of r.results) {
        assert.match(x.test_id, /^[a-z]+:[^:]*::.+/, `${c.fixture}: ${x.test_id}`);
        assert.ok(['pass', 'fail', 'skip', 'error'].includes(x.status));
      }
    }
  });
}

test('the same test gets the same id from every output form of a framework', () => {
  const by = (fixture) => runCase(CASES.find((c) => c.fixture === fixture));
  assert.deepEqual(ids(by('vitest/default.txt'), 'fail'), ids(by('vitest/report.json'), 'fail'));
  assert.deepEqual(ids(by('vitest/agent-v4.txt'), 'fail'), ids(by('vitest/verbose.txt'), 'fail'));
  assert.deepEqual(ids(by('vitest/verbose.txt')), ids(by('vitest/report.json')));
  assert.deepEqual(ids(by('jest/verbose.txt')), ids(by('jest/report.json')));
  assert.deepEqual(ids(by('jest/default.txt'), 'fail'), ids(by('jest/report.json'), 'fail'));
  assert.deepEqual(ids(by('pytest/verbose.txt')), ids(by('junit/pytest-junit.xml')));
  assert.deepEqual(ids(by('pytest/default.txt'), 'fail'), ids(by('junit/pytest-junit.xml'), 'fail'));
  assert.deepEqual(ids(by('go/verbose.txt')), ids(by('go/json.txt')));
  assert.deepEqual(ids(by('go/default.txt'), 'fail'), ids(by('go/json.txt'), 'fail'));
  assert.deepEqual(ids(by('tsc/default.txt')), ids(by('tsc/pretty.txt')));
  assert.deepEqual(ids(by('ruff/default.txt')), ids(by('ruff/concise.txt')));
  // Totals come from the reporter even when it lists only failures.
  assert.deepEqual(by('jest/default.txt').summary, by('jest/report.json').summary);
  assert.deepEqual(by('pytest/default.txt').summary, { passed: 2, failed: 3, skipped: 1, errors: 1, total: 7 });
});

test('the command picks the parser; a JUnit report written during the run is found', () => {
  assert.equal(hintFor('npx vitest run src').framework, 'vitest');
  assert.equal(hintFor('python -m pytest -q').framework, 'pytest');
  assert.equal(hintFor('cargo clippy -- -D warnings').framework, 'clippy');
  assert.equal(hintFor('node --test test/').framework, 'node');
  assert.equal(hintFor('npm test'), null);
  const repo = makeRepo();
  const startedAt = Date.now();
  fs.mkdirSync(path.join(repo.dir, 'target/surefire-reports'), { recursive: true });
  fs.copyFileSync(path.join(DIR, 'junit/surefire-TEST-com.shop.CartTest.xml'), path.join(repo.dir, 'target/surefire-reports/TEST-com.shop.CartTest.xml'));
  const r = parseResults({ command: 'mvn test', text: '[INFO] BUILD FAILURE', cwd: repo.dir, root: repo.dir, startedAt });
  assert.equal(r.framework, 'junit');
  assert.deepEqual(ids(r, 'fail'), ['junit:com.shop.CartTest::appliesDiscount']);
  assert.equal(r.summary.total, 3);
});

test('RP12 unrecognised output → null, and the run is still recorded', () => {
  assert.equal(parseResults({ command: 'make check', text: 'compiling…\nsomething went wrong\n', cwd: '/w', root: '/w' }), null);
  const repo = makeRepo({ git: true });
  const r = repo.kerb(['run', '--class', 'check', '--', 'echo "no test framework here"; exit 1']);
  assert.equal(r.code, 1);
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(end.framework, 'unknown');
  assert.equal(end.tests_summary, null);
  assert.equal(records(repo.dir).filter((x) => x.type === 'test_result').length, 0);
});

test('RP13 messages are redacted and truncated', () => {
  const secret = 'AKIAABCDEFGHIJKLMNOP';
  const long = 'x'.repeat(500);
  const text = [
    'tests/test_a.py::test_key FAILED',
    'tests/test_a.py::test_long FAILED',
    '=================================== FAILURES ===================================',
    '__________________________________ test_key ___________________________________',
    `E       AssertionError: bad key ${secret} for Bearer abc.def.ghi`,
    'tests/test_a.py:3: AssertionError',
    '__________________________________ test_long __________________________________',
    `E       AssertionError: ${long}`,
    'tests/test_a.py:7: AssertionError',
    '============================== 2 failed in 0.01s ===============================',
  ].join('\n');
  const r = parseResults({ command: 'pytest', text, cwd: '/w', root: '/w' });
  const key = r.results.find((x) => x.test_id.endsWith('test_key'));
  assert.doesNotMatch(key.message, new RegExp(secret));
  assert.match(key.message, /\[REDACTED\]/);
  const lng = r.results.find((x) => x.test_id.endsWith('test_long'));
  assert.equal(lng.message.length, 200);
  assert.ok(lng.message.endsWith('…'));
});

test('RP14 a 50 MB output parses within budget or falls back', () => {
  const line = (i) => ` ✓ src/big.test.js > suite > test number ${i} padded to make the line a little longer 1ms\n`;
  const n = Math.ceil((50 * 1024 * 1024) / line(0).length);
  const text = ` RUN  v3.2.7 /w\n\n${Array.from({ length: n }, (_, i) => line(i)).join('')}      Tests  ${n} passed (${n})\n`;
  const t0 = Date.now();
  const r = parseResults({ command: 'npx vitest run --reporter=verbose', text, cwd: '/w', root: '/w' });
  const ms = Date.now() - t0;
  assert.ok(ms < 5000 * 2, `took ${ms} ms (budget ${50 * 100} ms)`);
  if (r) {
    assert.equal(r.summary.total, n);
    assert.ok(r.results.length <= 2000, 'results capped');
    assert.equal(r.summary.truncated, true);
  }
  // A budget too small to finish → null, not an error.
  assert.equal(parseResults({ command: 'npx vitest run --reporter=verbose', text, cwd: '/w', root: '/w', deadline: Date.now() + 1 }), null);
});

test('kerb run and the hooks record test results with the run', () => {
  const repo = makeRepo({ git: true, files: {
    'cart.test.js': "const { it } = require('node:test');\nconst assert = require('node:assert/strict');\nit('adds', () => {});\nit('applies discount', () => { assert.equal(100, 90); });\n",
  } });
  const r = repo.kerb(['run', '--', 'node --test --test-reporter=tap cart.test.js']);
  assert.equal(r.code, 1);
  const recs = records(repo.dir);
  const end = recs.find((x) => x.type === 'end');
  assert.equal(end.framework, 'node');
  assert.deepEqual({ ...end.tests_summary }, { passed: 1, failed: 1, skipped: 0, errors: 0, total: 2 });
  const tr = recs.filter((x) => x.type === 'test_result');
  assert.deepEqual(tr.map((x) => [x.test_id, x.status]).sort(), [['node:cart.test.js::adds', 'pass'], ['node:cart.test.js::applies discount', 'fail']]);
  assert.ok(tr.every((x) => x.run === end.id && x.state === end.post_hash && x.key === end.key));
  // Hooks: the agent's output text is parsed the same way.
  const p = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'pytest -v' }, tool_use_id: 'py1' };
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) });
  repo.kerb(['hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p, error: `Exit code 1\n${fs.readFileSync(path.join(DIR, 'pytest/verbose.txt'), 'utf8')}` }) });
  const py = records(repo.dir).filter((x) => x.type === 'test_result' && x.test_id.startsWith('pytest:'));
  assert.equal(py.length, 7);
  assert.equal(records(repo.dir).filter((x) => x.type === 'end').pop().framework, 'pytest');
});
