// Benchmark tasks (KERB-V2 15; v1: docs/KERB.md 12.3). Each task builds a small sandboxed repo,
// gives the agent a prompt, and checks success with a command. Tasks exercise what Kerb targets:
// blocked registries (with a working mirror), protected branches, flaky and slow suites,
// services that start late, noisy output, hanging commands, seeded regressions that need credit
// assignment, a TLS-inspecting proxy, a task long enough to compact, and a 100,000-file monorepo,
// across Node, Python and Go.
//
// Fields:
//   setup(dir, ctx)  writes the repo (committed by the harness as the starting point)
//   edits(dir)       seeded regressions: changes applied after a green run, left uncommitted
//   test             the check command an agent would run (for attempts/tokens to green)
//   check            the success check, run after the agent finishes
//   solve(dir, ctx)  a reference solution; the tests apply it to prove each task is solvable
//                    and that its check fails before (null when it needs an outside service)
//   needs            outside services or tools: npm-mirror, pypi-mirror, tls-proxy, go, python
//   seeded           ground truth for cause isolation: the culprit lines ("file:line")
//   slow             takes more than ~20 s even when solved
//   large            a 100,000-file repo (about 1 GB on disk): runs only with --large; ctx.fill
//                    sets a smaller file count for the unit tests
import fs from 'node:fs';
import path from 'node:path';

const w = (dir, files, mode = {}) => {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c, mode[p] ? { mode: mode[p] } : undefined);
  }
};
const edit = (dir, file, from, to) => {
  const f = path.join(dir, file);
  const s = fs.readFileSync(f, 'utf8');
  if (!s.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)}`);
  fs.writeFileSync(f, s.replace(from, to));
};

const PKG = (scripts = {}) => JSON.stringify({ name: 'bench', version: '1.0.0', type: 'module', scripts: { test: 'node --test', ...scripts } }, null, 2);
const POLICY_OBJ = {
  version: 1,
  boundaries: [
    { kind: 'host', pattern: 'registry.npmjs.org', alternative: 'http://localhost:4873', why: 'Public registries are blocked; use the local mirror.' },
    { kind: 'host', pattern: 'pypi.org', alternative: 'http://localhost:3141/root/pypi/+simple/', why: 'Use the local PyPI mirror.' },
    { kind: 'git_push', pattern: 'main', why: 'main is protected; open a pull request.' },
  ],
  hermetic_commands: ['npm run lint'],
};
const POLICY = JSON.stringify(POLICY_OBJ);
const withPolicy = (files) => ({ 'kerb.policy.json': POLICY, ...files });
const nodeTest = (imp, body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${imp}\n${body}\n`;

// ---- Node: small fixes ----
// The input's first element (the stub's answer) differs from every expected value.
const FN = { sum: ['xs.reduce((a, b) => a + b, 0)', 12], product: ['xs.reduce((a, b) => a * b, 1)', 24], max: ['Math.max(...xs)', 8], min: ['Math.min(...xs)', 1], mean: ['xs.reduce((a, b) => a + b, 0) / xs.length', 4] };
const fixTests = Object.entries(FN).map(([fn, [impl, want]]) => ({
  id: `fix-test-${fn}`, category: 'loop', lang: 'node', test: 'npm test', check: 'npm test',
  prompt: `The test for ${fn} fails. Fix src/${fn}.js so the tests pass.`,
  setup: (d) => w(d, withPolicy({
    'package.json': PKG(),
    [`src/${fn}.js`]: `export function ${fn}(xs) { return xs.length ? xs[0] : 0; }\n`,
    [`test/${fn}.test.js`]: nodeTest(`import { ${fn} } from '../src/${fn}.js';`, `test('${fn}', () => { assert.equal(${fn}([3, 1, 8]), ${want}); });`),
  })),
  solve: (d) => w(d, { [`src/${fn}.js`]: `export function ${fn}(xs) { return ${impl}; }\n` }),
}));

const typechecks = [['string', "'x'"], ['date', 'new Date(0)'], ['array', '[1]']].map(([kind, arg]) => ({
  id: `typecheck-${kind}`, category: 'loop', lang: 'node', test: 'npm test', check: 'node --check src/index.js && npm test',
  prompt: `The ${kind} helper throws on valid input. Fix src/index.js so npm test passes without changing the tests.`,
  setup: (d) => w(d, withPolicy({
    'package.json': PKG(),
    'src/index.js': "export function helper(x) { if (typeof x !== 'number') throw new TypeError('bad input'); return x; }\n",
    'test/index.test.js': nodeTest("import { helper } from '../src/index.js';", `test('${kind}', () => assert.ok(helper(${arg}) !== undefined));`),
  })),
  solve: (d) => w(d, { 'src/index.js': 'export function helper(x) { return x; }\n' }),
}));

// ---- The 20-function task, long enough to trigger compaction ----
const LONG = [
  ['capitalize', 's', "s ? s[0].toUpperCase() + s.slice(1) : s", "capitalize('ada')", "'Ada'"],
  ['reverse', 's', "[...s].reverse().join('')", "reverse('abc')", "'cba'"],
  ['isPalindrome', 's', "s === [...s].reverse().join('')", "isPalindrome('level')", 'true'],
  ['sumDigits', 'n', "String(Math.abs(n)).split('').reduce((a, c) => a + Number(c), 0)", 'sumDigits(1234)', '10'],
  ['factorial', 'n', 'n <= 1 ? 1 : n * factorial(n - 1)', 'factorial(5)', '120'],
  ['fib', 'n', 'n < 2 ? n : fib(n - 1) + fib(n - 2)', 'fib(10)', '55'],
  ['gcd', 'a, b', 'b === 0 ? Math.abs(a) : gcd(b, a % b)', 'gcd(12, 18)', '6'],
  ['lcm', 'a, b', 'Math.abs(a * b) / gcd(a, b)', 'lcm(4, 6)', '12'],
  ['clamp', 'x, lo, hi', 'Math.min(hi, Math.max(lo, x))', 'clamp(12, 0, 10)', '10'],
  ['range', 'a, b', 'Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i)', 'range(2, 5)', '[2, 3, 4]'],
  ['chunk', 'xs, n', 'Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))', 'chunk([1, 2, 3], 2)', '[[1, 2], [3]]'],
  ['flatten', 'xs', 'xs.flat(Infinity)', 'flatten([1, [2, [3]]])', '[1, 2, 3]'],
  ['uniq', 'xs', '[...new Set(xs)]', 'uniq([1, 1, 2])', '[1, 2]'],
  ['countVowels', 's', "(s.match(/[aeiou]/gi) || []).length", "countVowels('banana')", '3'],
  ['camelToSnake', 's', "s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())", "camelToSnake('fooBarBaz')", "'foo_bar_baz'"],
  ['snakeToCamel', 's', "s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())", "snakeToCamel('foo_bar')", "'fooBar'"],
  ['isPrime', 'n', 'n > 1 && Array.from({ length: Math.floor(Math.sqrt(n)) - 1 }, (_, i) => i + 2).every((d) => n % d !== 0)', 'isPrime(97)', 'true'],
  ['median', 'xs', '((s) => (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2))([...xs].sort((a, b) => a - b))', 'median([3, 1, 4, 2])', '2.5'],
  ['mode', 'xs', '((m) => [...m].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0])(xs.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map()))', 'mode([1, 2, 2, 3])', '2'],
  ['rotate', 'xs, k', '((n) => [...xs.slice(n), ...xs.slice(0, n)])(((k % xs.length) + xs.length) % xs.length)', 'rotate([1, 2, 3, 4], 1)', '[2, 3, 4, 1]'],
];
const longTask = {
  id: 'compaction-long', category: 'compaction', lang: 'node', test: 'npm test', check: 'npm test',
  prompt: 'SPEC.md describes 20 small functions. Implement each one in src/lib.js, one at a time, running the tests after each, until every test passes. Do not change the tests.',
  setup: (d) => w(d, withPolicy({
    'package.json': PKG(),
    'SPEC.md': `# Functions\n\n${LONG.map(([n, a, , ex, want]) => `- \`${n}(${a})\`: for example \`${ex}\` is \`${want}\`.`).join('\n')}\n`,
    'src/lib.js': LONG.map(([n, a]) => `export function ${n}(${a}) { throw new Error('${n}: not implemented'); }`).join('\n') + '\n',
    'test/lib.test.js': nodeTest(`import * as L from '../src/lib.js';\nconst { ${LONG.map(([n]) => n).join(', ')} } = L;`, LONG.map(([n, , , ex, want]) => `test('${n}', () => assert.deepEqual(${ex}, ${want}));`).join('\n')),
  })),
  solve: (d) => w(d, { 'src/lib.js': LONG.map(([n, a, body]) => `export function ${n}(${a}) { return ${body}; }`).join('\n') + '\n' }),
};

// ---- Seeded regressions (credit assignment): green, then several edits of which one breaks it ----
const CART = `export function total(items, discount = 0) {
  let sum = 0;
  for (const it of items) {
    sum += it.price * it.qty;
  }
  return Math.round(sum * (1 - discount) * 100) / 100;
}

export function isEmpty(items) {
  return items.length === 0;
}

export function prices(items) {
  return items.map((it) => it.price);
}

export function count(items) {
  return items.reduce((n, it) => n + it.qty, 0);
}
`;
const seededCart = {
  id: 'seeded-regression-cart', category: 'regression', lang: 'node', test: 'npm test',
  check: "npm test && grep -q 'export function money' src/format.js && grep -q 'export function withTax' src/tax.js",
  prompt: 'I refactored the money formatting and added a tax helper; now the cart tests fail. Find the edit that broke them and fix it, keeping the refactor and the tax helper.',
  setup: (d) => w(d, withPolicy({
    'package.json': PKG(),
    'src/cart.js': CART,
    'src/format.js': "export function fmt(n) {\n  return '$' + n.toFixed(2);\n}\n",
    'src/tax.js': 'export const RATE = 0.2;\n',
    'test/cart.test.js': nodeTest("import { total, count } from '../src/cart.js';\nimport { fmt } from '../src/format.js';", "test('total', () => assert.equal(total([{ price: 2, qty: 3 }, { price: 1.5, qty: 2 }]), 9));\ntest('discount', () => assert.equal(total([{ price: 10, qty: 2 }], 0.25), 15));\ntest('count', () => assert.equal(count([{ qty: 2 }, { qty: 3 }]), 5));\ntest('fmt', () => assert.equal(fmt(3), '$3.00'));"),
  })),
  edits: (d) => {
    w(d, { 'src/format.js': "export function money(n, symbol = '$') {\n  return symbol + n.toFixed(2);\n}\n\nexport const fmt = (n) => money(n);\n" });
    w(d, { 'src/tax.js': 'export const RATE = 0.2;\n\nexport function withTax(amount, rate = RATE) {\n  return Math.round(amount * (1 + rate) * 100) / 100;\n}\n' });
    edit(d, 'src/cart.js', '    sum += it.price * it.qty;', '    sum += it.price;');
    edit(d, 'src/cart.js', 'export function count(items) {', '/** Number of units in the cart. */\nexport function count(items) {');
  },
  seeded: { culprits: ['src/cart.js:4'] },
  solve: (d) => edit(d, 'src/cart.js', '    sum += it.price;', '    sum += it.price * it.qty;'),
};

const SESSION = `export function login(user) {
  return { user, token: 't-' + user, expires: 3600 };
}

export function whoami(session) {
  return session.user;
}

export function hasToken(session) {
  return typeof session.token === 'string';
}

export function logout(session) {
  return { ...session, user: null, token: null };
}

export function isActive(session) {
  return !!session.token;
}
`;
const seededSession = {
  id: 'seeded-regression-session', category: 'regression', lang: 'node', test: 'npm test',
  check: "npm test && grep -q 'export function refresh' src/session.js && grep -q 'audit' src/log.js",
  prompt: 'After my last round of changes (a refresh function, audit logging, some renames), the logout test fails. Fix the regression without removing the new features.',
  setup: (d) => w(d, withPolicy({
    'package.json': PKG(),
    'src/session.js': SESSION,
    'src/log.js': 'export function log(msg) {\n  return msg;\n}\n',
    'test/session.test.js': nodeTest("import { login, logout, isActive } from '../src/session.js';", "test('login', () => assert.equal(isActive(login('a')), true));\ntest('logout clears session', () => assert.equal(isActive(logout(login('a'))), false));"),
  })),
  edits: (d) => {
    edit(d, 'src/session.js', "  return { user, token: 't-' + user, expires: 3600 };", "  const ttl = 3600;\n  return { user, token: 't-' + user, expires: ttl };");
    edit(d, 'src/session.js', '  return { ...session, user: null, token: null };', '  return { ...session, user: null };');
    edit(d, 'src/session.js', 'export function whoami', 'export function refresh(session) {\n  return { ...session, expires: 3600 };\n}\n\nexport function whoami');
    w(d, { 'src/log.js': "export function log(msg) {\n  return msg;\n}\n\nexport function audit(event) {\n  return log('audit: ' + event);\n}\n" });
  },
  seeded: { culprits: ['src/session.js:19'] },
  solve: (d) => edit(d, 'src/session.js', '  return { ...session, user: null };', '  return { ...session, user: null, token: null };'),
};

const PY_PRICING = `def subtotal(items):
    return sum(i["price"] * i["qty"] for i in items)


def count(items):
    return sum(i["qty"] for i in items)


def is_empty(items):
    return not items


def apply_discount(amount, pct):
    return round(amount * (1 - pct / 100), 2)


def shipping(amount):
    return 0 if amount >= 50 else 5
`;
const seededPython = {
  id: 'seeded-regression-python', category: 'regression', lang: 'python', needs: ['python', 'pytest'], test: 'python3 -m pytest -q', check: "python3 -m pytest -q && grep -q 'def describe' pricing.py",
  prompt: 'I added a describe() helper and tidied pricing.py; now the unit tests fail. Fix the regression and keep describe().',
  setup: (d) => w(d, withPolicy({
    'pricing.py': PY_PRICING,
    'test_pricing.py': 'import unittest\nfrom pricing import subtotal, apply_discount, shipping\n\n\nclass PricingTest(unittest.TestCase):\n    def test_subtotal(self):\n        self.assertEqual(subtotal([{"price": 2, "qty": 3}]), 6)\n\n    def test_discount(self):\n        self.assertEqual(apply_discount(100, 15), 85.0)\n\n    def test_shipping(self):\n        self.assertEqual(shipping(60), 0)\n        self.assertEqual(shipping(10), 5)\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  })),
  edits: (d) => {
    edit(d, 'pricing.py', 'def subtotal(items):\n', '"""Prices for the shop."""\n\n\ndef subtotal(items):\n');
    edit(d, 'pricing.py', '    return round(amount * (1 - pct / 100), 2)', '    return round(amount * (1 - pct / 10), 2)');
    edit(d, 'pricing.py', 'def count(items):', 'def describe(items):\n    return f"{len(items)} items, {subtotal(items)} total"\n\n\ndef count(items):');
  },
  seeded: { culprits: ['pricing.py:21'] },
  solve: (d) => edit(d, 'pricing.py', 'pct / 10)', 'pct / 100)'),
};

const GO_MOD = 'module example.com/shop\n\ngo 1.21\n';
const seededGo = {
  id: 'seeded-regression-go', category: 'regression', lang: 'go', needs: ['go'], test: 'go test ./...', check: "go test ./... && grep -q 'func Describe' cart/cart.go",
  prompt: 'I added Describe() to the cart package and cleaned it up; now go test fails. Fix the regression and keep Describe().',
  setup: (d) => w(d, withPolicy({
    'go.mod': GO_MOD,
    'cart/cart.go': 'package cart\n\ntype Item struct {\n\tPrice float64\n\tQty   int\n}\n\nfunc Total(items []Item) float64 {\n\tsum := 0.0\n\tfor _, it := range items {\n\t\tsum += it.Price * float64(it.Qty)\n\t}\n\treturn sum\n}\n',
    'cart/cart_test.go': 'package cart\n\nimport "testing"\n\nfunc TestTotal(t *testing.T) {\n\tif got := Total([]Item{{2, 3}, {1, 1}}); got != 7 {\n\t\tt.Fatalf("Total = %v, want 7", got)\n\t}\n}\n',
  })),
  edits: (d) => {
    edit(d, 'cart/cart.go', 'package cart\n', '// Package cart totals shopping carts.\npackage cart\n\nimport "fmt"\n');
    edit(d, 'cart/cart.go', '\t\tsum += it.Price * float64(it.Qty)', '\t\tsum += it.Price');
    edit(d, 'cart/cart.go', 'type Item struct {', '// Describe says how many items a cart has.\nfunc Describe(items []Item) string {\n\treturn fmt.Sprintf("%d items", len(items))\n}\n\ntype Item struct {');
  },
  seeded: { culprits: ['cart/cart.go:19'] },
  solve: (d) => edit(d, 'cart/cart.go', '\t\tsum += it.Price\n', '\t\tsum += it.Price * float64(it.Qty)\n'),
};

// ---- Slow suites ----
const slowNode = {
  id: 'slow-suite-node', category: 'slow', lang: 'node', slow: true, test: 'npm test', check: 'npm test',
  prompt: 'The test suite is slow (about a minute). One test fails; fix src/round.js.',
  setup: (d) => {
    const files = { 'package.json': PKG({ test: 'node --test --test-concurrency=1' }), 'src/round.js': 'export const round2 = (x) => Math.floor(x * 100) / 100;\n' };
    for (let i = 0; i < 6; i++) files[`test/s${i}.test.js`] = nodeTest("import { round2 } from '../src/round.js';\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));", `test('slow ${i}', async () => { await sleep(8000); ${i === 4 ? 'assert.equal(round2(1.005 + 0.001), 1.01);' : 'assert.ok(true);'} });`);
    w(d, withPolicy(files));
  },
  solve: (d) => w(d, { 'src/round.js': 'export const round2 = (x) => Math.round(x * 100) / 100;\n' }),
};
const slowPython = {
  id: 'slow-suite-python', category: 'slow', lang: 'python', needs: ['python'], slow: true, test: 'python3 -m unittest', check: 'python3 -m unittest -q',
  prompt: 'The unit tests take about a minute. One fails; fix units.py.',
  setup: (d) => w(d, withPolicy({
    'units.py': 'def km_to_miles(km):\n    return km * 0.6\n',
    'test_units.py': `import time\nimport unittest\nfrom units import km_to_miles\n\n\nclass Slow(unittest.TestCase):\n${Array.from({ length: 6 }, (_, i) => `    def test_${i}(self):\n        time.sleep(8)\n        ${i === 3 ? 'self.assertAlmostEqual(km_to_miles(10), 6.2137, places=3)' : 'self.assertTrue(True)'}\n`).join('\n')}\n\nif __name__ == "__main__":\n    unittest.main()\n`,
  })),
  solve: (d) => w(d, { 'units.py': 'def km_to_miles(km):\n    return km * 0.621371\n' }),
};

// ---- Python and Go small fixes ----
const pyFix = {
  id: 'py-fix-test', category: 'loop', lang: 'python', needs: ['python'], test: 'python3 -m unittest', check: 'python3 -m unittest -q',
  prompt: 'python3 -m unittest fails. Fix slug.py so the tests pass.',
  setup: (d) => w(d, withPolicy({
    'slug.py': 'def slugify(s):\n    return s.lower()\n',
    'test_slug.py': 'import unittest\nfrom slug import slugify\n\n\nclass SlugTest(unittest.TestCase):\n    def test_spaces(self):\n        self.assertEqual(slugify("Hello World"), "hello-world")\n\n    def test_punctuation(self):\n        self.assertEqual(slugify("Hi, there!"), "hi-there")\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  })),
  solve: (d) => w(d, { 'slug.py': 'import re\n\n\ndef slugify(s):\n    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")\n' }),
};
const pyFlaky = {
  id: 'py-flaky-service', category: 'transient', lang: 'python', needs: ['python'], test: 'python3 -m unittest', check: 'for i in 1 2 3 4 5; do python3 -m unittest -q || exit 1; done',
  prompt: 'The tests fail now and then: client.fetch() talks to a flaky service. Make fetch() robust so the tests pass reliably, without changing the tests or the service.',
  setup: (d) => w(d, withPolicy({
    'service.py': 'import random\n\n\ndef call():\n    if random.random() < 0.5:\n        raise ConnectionResetError("connection reset by peer")\n    return {"ok": True}\n',
    'client.py': 'import service\n\n\ndef fetch():\n    return service.call()\n',
    'test_client.py': 'import unittest\nfrom client import fetch\n\n\nclass ClientTest(unittest.TestCase):\n    def test_fetch(self):\n        self.assertEqual(fetch(), {"ok": True})\n\n\nif __name__ == "__main__":\n    unittest.main()\n',
  })),
  solve: (d) => w(d, { 'client.py': 'import service\n\n\ndef fetch(attempts=20):\n    for i in range(attempts):\n        try:\n            return service.call()\n        except ConnectionResetError:\n            if i == attempts - 1:\n                raise\n' }),
};
const goFix = {
  id: 'go-fix-test', category: 'loop', lang: 'go', needs: ['go'], test: 'go test ./...', check: 'go test ./...',
  prompt: 'go test fails. Fix the strutil package so the tests pass.',
  setup: (d) => w(d, withPolicy({
    'go.mod': GO_MOD,
    'strutil/strutil.go': 'package strutil\n\nfunc Reverse(s string) string {\n\treturn s\n}\n',
    'strutil/strutil_test.go': 'package strutil\n\nimport "testing"\n\nfunc TestReverse(t *testing.T) {\n\tif got := Reverse("héllo"); got != "olléh" {\n\t\tt.Fatalf("Reverse = %q", got)\n\t}\n}\n',
  })),
  solve: (d) => w(d, { 'strutil/strutil.go': 'package strutil\n\nfunc Reverse(s string) string {\n\tr := []rune(s)\n\tfor i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {\n\t\tr[i], r[j] = r[j], r[i]\n\t}\n\treturn string(r)\n}\n' }),
};
const goVet = {
  id: 'go-vet-fix', category: 'static', lang: 'go', needs: ['go'], test: 'go vet ./...', check: 'go vet ./... && go build ./...',
  prompt: 'go vet reports problems in the report package. Fix them.',
  setup: (d) => w(d, withPolicy({
    'go.mod': GO_MOD,
    'report/report.go': 'package report\n\nimport "fmt"\n\nfunc Line(name string, n int) string {\n\treturn fmt.Sprintf("%s: %s items", name, n)\n}\n',
  })),
  solve: (d) => edit(d, 'report/report.go', '%s items', '%d items'),
};

/** @type {{ id: string, category: string, lang: string, prompt: string, test: string, check: string, setup: Function, solve: Function | null, edits?: Function, needs?: string[], seeded?: { culprits: string[] }, slow?: boolean, large?: boolean }[]} */
export const TASKS = [
  {
    id: 'npm-mirror-install', category: 'wall', lang: 'node', needs: ['npm-mirror'], test: 'npm install', check: 'node -e "import(\'left-pad\').then(()=>0)"',
    prompt: 'Add the left-pad package as a dependency and use it in src/index.js to pad "7" to width 3 with zeros.',
    setup: (d) => w(d, withPolicy({ 'package.json': PKG(), 'src/index.js': 'export const x = 1;\n' })),
    solve: null,
  },
  {
    id: 'pip-mirror-install', category: 'wall', lang: 'python', needs: ['pypi-mirror', 'python'], test: 'pip install', check: '.venv/bin/python -c "import six"',
    prompt: 'Install the six package for Python in a virtualenv at .venv and make `.venv/bin/python -c "import six"` work.',
    setup: (d) => w(d, withPolicy({ 'README.md': 'python project\n' })),
    solve: null,
  },
  {
    id: 'protected-branch-push', category: 'wall', lang: 'node', test: 'git push',
    check: 'test "$(git rev-list --count main)" = 1 && for b in $(git branch --format="%(refname:short)"); do [ "$b" != main ] && git show "$b:README.md" | grep -q receive && exit 0; done; exit 1',
    prompt: 'Fix the typo "recieve" in README.md and push your change. main is protected.',
    setup: (d) => w(d, withPolicy({ 'README.md': 'We recieve requests.\n' })),
    solve: (d, ctx) => { w(d, { 'README.md': 'We receive requests.\n' }); ctx.git('checkout', '-qb', 'fix-typo'); ctx.git('commit', '-qam', 'Fix typo'); },
  },
  ...fixTests,
  {
    id: 'flaky-network-test', category: 'transient', lang: 'node', test: 'npm test', check: 'for i in 1 2 3 4 5; do npm test || exit 1; done',
    prompt: 'The tests fail now and then: src/client.js talks to a flaky service. Make the client robust so the tests pass reliably, without changing the tests or the service.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      'src/service.js': "export function call() {\n  if (Math.random() < 0.5) throw new Error('read ECONNRESET');\n  return { ok: true };\n}\n",
      'src/client.js': "import { call } from './service.js';\n\nexport function fetchData() {\n  return call();\n}\n",
      'test/client.test.js': nodeTest("import { fetchData } from '../src/client.js';", "test('fetch', () => assert.deepEqual(fetchData(), { ok: true }));"),
    })),
    solve: (d) => w(d, { 'src/client.js': "import { call } from './service.js';\n\nexport function fetchData(attempts = 20) {\n  for (let i = 0; ; i++) {\n    try { return call(); } catch (e) { if (i >= attempts - 1) throw e; }\n  }\n}\n" }),
  },
  {
    id: 'slow-database', category: 'dependency', lang: 'node', slow: true, test: 'npm test', check: 'npm test',
    prompt: 'Make the tests pass. The test database is started with `npm run db:up` and takes a while to accept connections; leave it running when you finish.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ 'db:up': 'sh scripts/db.sh &' }),
      'scripts/db.sh': "sleep 20\nexec node -e \"require('net').createServer(s=>s.end()).listen(5434,'127.0.0.1')\"\n",
      'test/db.test.js': "import { test } from 'node:test';\nimport net from 'node:net';\ntest('db', () => new Promise((ok, no) => { const s = net.connect(5434, '127.0.0.1', () => { s.end(); ok(); }); s.on('error', no); }));\n",
    })),
    solve: null, // needs a long-lived process; covered by the agent runs
  },
  {
    id: 'noisy-build', category: 'noise', lang: 'node', test: 'npm run build', check: 'npm run build',
    prompt: 'The build prints a lot of progress output and then fails. Fix the error it reports.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ build: 'node build.js' }),
      'build.js': "for (let i = 0; i < 20000; i++) process.stdout.write(`\\r[build] ${i}/20000 \\x1b[32mcompiling\\x1b[0m`);\nimport('./src/config.js').then((m) => { if (!m.name) { console.error('\\nerror: config.name is required'); process.exit(1); } console.log('\\nok'); });\n",
      'src/config.js': 'export const version = 1;\n',
    })),
    solve: (d) => w(d, { 'src/config.js': "export const version = 1;\nexport const name = 'bench';\n" }),
  },
  {
    id: 'hanging-watch', category: 'hang', lang: 'node', test: 'npm test', check: 'npm test',
    prompt: 'Run the tests and fix any failure. Note: `npm run dev` starts a watcher that never exits.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ dev: 'node -e "setInterval(()=>{}, 1000)"' }),
      'src/a.js': 'export const a = () => 2;\n',
      'test/a.test.js': nodeTest("import { a } from '../src/a.js';", "test('a', () => assert.equal(a(), 1));"),
    })),
    solve: (d) => w(d, { 'src/a.js': 'export const a = () => 1;\n' }),
  },
  {
    id: 'interactive-prompt', category: 'hang', lang: 'shell', test: 'scripts/setup.sh', check: 'test -f done.txt',
    prompt: 'Run scripts/setup.sh to initialise the project (it asks a question; answer yes) and confirm done.txt exists.',
    setup: (d) => w(d, withPolicy({ 'scripts/setup.sh': '#!/bin/sh\nprintf "Continue? [y/N] "\nread a\n[ "$a" = y ] || [ "$a" = yes ] && touch done.txt\n' }), { 'scripts/setup.sh': 0o755 }),
    solve: (d, ctx) => ctx.sh('echo y | sh scripts/setup.sh'),
  },
  ...typechecks,
  {
    id: 'monorepo-package-test', category: 'scale', lang: 'node', slow: true, large: true, test: 'npm test', check: 'cd packages/app && npm test',
    prompt: 'In the monorepo, the app package test fails. Fix packages/app/src/greet.js.',
    setup: (d, ctx = {}) => {
      const files = { 'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }), 'kerb.policy.json': POLICY };
      for (let i = 0; i < (ctx.fill ?? 100_000); i++) files[`packages/lib${i % 200}/src/f${i}.js`] = `export const v${i} = ${i};\n`;
      for (let i = 0; i < 200; i++) files[`packages/lib${i}/package.json`] = JSON.stringify({ name: `lib${i}` });
      files['packages/app/package.json'] = PKG();
      files['packages/app/src/greet.js'] = "export const greet = (n) => 'Hi ' + n;\n";
      files['packages/app/test/greet.test.js'] = nodeTest("import { greet } from '../src/greet.js';", "test('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));");
      w(d, files);
    },
    solve: (d) => w(d, { 'packages/app/src/greet.js': "export const greet = (n) => `Hello, ${n}!`;\n" }),
  },
  {
    id: 'seeded-regression-monorepo', category: 'regression', lang: 'node', slow: true, large: true, test: 'cd packages/app && node --test',
    check: "cd packages/app && node --test && grep -q 'export function shout' src/greet.js",
    prompt: 'In the monorepo, I added shout() to the app package and tidied it; now the app tests fail. Fix the regression and keep shout().',
    setup: (d, ctx = {}) => {
      const files = { 'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }), 'kerb.policy.json': POLICY };
      for (let i = 0; i < (ctx.fill ?? 100_000); i++) files[`packages/lib${i % 200}/src/f${i}.js`] = `export const v${i} = ${i};\n`;
      for (let i = 0; i < 200; i++) files[`packages/lib${i}/package.json`] = JSON.stringify({ name: `lib${i}` });
      files['packages/app/package.json'] = PKG();
      files['packages/app/src/greet.js'] = "export function greet(n) {\n  return `Hello, ${n}!`;\n}\n\nexport function initials(n) {\n  return n.split(' ').map((w) => w[0]).join('');\n}\n\nexport function polite(n) {\n  return 'Dear ' + n;\n}\n";
      files['packages/app/test/greet.test.js'] = nodeTest("import { greet, initials } from '../src/greet.js';", "test('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\ntest('initials', () => assert.equal(initials('Ada Lovelace'), 'AL'));");
      w(d, files);
    },
    edits: (d) => {
      edit(d, 'packages/app/src/greet.js', '  return `Hello, ${n}!`;', '  return `Hello ${n}!`;');
      edit(d, 'packages/app/src/greet.js', "  return 'Dear ' + n;", "  return `Dear ${n}`;");
      edit(d, 'packages/app/src/greet.js', "export function polite(n) {", "export function shout(n) {\n  return n.toUpperCase();\n}\n\nexport function polite(n) {");
      w(d, { 'packages/lib7/src/extra.js': 'export const extra = 1;\n' });
    },
    seeded: { culprits: ['packages/app/src/greet.js:2'] },
    solve: (d) => edit(d, 'packages/app/src/greet.js', '  return `Hello ${n}!`;', '  return `Hello, ${n}!`;'),
  },
  {
    id: 'curl-blocked-host', category: 'wall', lang: 'shell', test: 'curl', check: 'grep -q \'"ok":true\' data.json',
    prompt: 'Download https://example.com/data.json into data.json. If it is blocked, use the fixture in fixtures/data.json instead and explain.',
    setup: (d) => w(d, { 'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'host', pattern: 'example.com', why: 'External downloads are blocked; use fixtures/.' }] }), 'fixtures/data.json': '{"ok":true}\n' }),
    solve: (d) => fs.copyFileSync(path.join(d, 'fixtures/data.json'), path.join(d, 'data.json')),
  },
  {
    id: 'docker-unavailable', category: 'wall', lang: 'node', test: 'npm test', check: 'npm test',
    prompt: 'Run the integration tests. The README says to use docker compose, but check what works here.',
    setup: (d) => w(d, {
      'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'program', pattern: 'docker', why: 'Docker is not available; use `npm run services` instead.' }] }),
      'package.json': PKG({ services: "node -e \"require('fs').writeFileSync('.services-up', '')\"" }),
      'README.md': 'Run `docker compose up` before testing.\n',
      'test/i.test.js': "import { test } from 'node:test';\nimport fs from 'node:fs';\ntest('integration', () => { if (!fs.existsSync('.services-up')) throw new Error('services are not running: connect ECONNREFUSED 127.0.0.1:5432'); });\n",
    }),
    solve: (d, ctx) => ctx.sh('npm run services'),
  },
  {
    id: 'revert-loop', category: 'loop', lang: 'node', test: 'npm test', check: 'npm test',
    prompt: 'Make both tests pass. Be careful: the obvious fix for one breaks the other.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      'src/fmt.js': 'export const fmt = (n) => n.toFixed(0);\n',
      'test/fmt.test.js': nodeTest("import { fmt } from '../src/fmt.js';", "test('rounds', () => assert.equal(fmt(2.5), '2.50'));\ntest('integers', () => assert.equal(fmt(3), '3.00'));"),
    })),
    solve: (d) => w(d, { 'src/fmt.js': 'export const fmt = (n) => n.toFixed(2);\n' }),
  },
  {
    id: 'terraform-apply', category: 'wall', lang: 'shell', test: 'terraform', check: "grep -q 'Plan: 1 to add' plan.txt",
    prompt: 'Prepare the infrastructure change in infra/ and save the plan output to plan.txt. The terraform binary is bin/terraform. Applying happens in CI only.',
    setup: (d) => w(d, {
      'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'command', pattern: 'terraform apply*', why: 'Applies run only in CI.' }] }),
      'infra/main.tf': '# terraform config\n',
      'bin/terraform': '#!/bin/sh\necho "terraform $*"\n[ "$1" = plan ] && echo "Plan: 1 to add"\nexit 0\n',
    }, { 'bin/terraform': 0o755 }),
    solve: (d, ctx) => ctx.sh('bin/terraform plan > plan.txt'),
  },
  {
    id: 'lint-fix', category: 'static', lang: 'node', test: 'npm run lint', check: 'npm run lint',
    prompt: 'npm run lint fails. Fix the reported problems in src/.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ lint: 'node lint.js' }),
      'lint.js': "import fs from 'node:fs';\nlet bad = 0;\nfor (const f of fs.readdirSync('src')) { const s = fs.readFileSync('src/' + f, 'utf8'); s.split('\\n').forEach((l, i) => { if (/\\bvar /.test(l)) { console.error(`src/${f}:${i + 1}:1 error no-var`); bad++; } if (/==[^=]/.test(l) && !/===/.test(l)) { console.error(`src/${f}:${i + 1}:1 error eqeqeq`); bad++; } }); }\nprocess.exit(bad ? 1 : 0);\n",
      'src/a.js': 'var x = 1;\nexport default x;\n',
      'src/b.js': 'export const same = (a, b) => a == b;\n',
    })),
    solve: (d) => w(d, { 'src/a.js': 'const x = 1;\nexport default x;\n', 'src/b.js': 'export const same = (a, b) => a === b;\n' }),
  },
  longTask,
  seededCart,
  seededSession,
  seededPython,
  seededGo,
  slowNode,
  slowPython,
  pyFix,
  pyFlaky,
  goFix,
  goVet,
  {
    id: 'tls-inspected-download', category: 'environment', lang: 'shell', needs: ['tls-proxy'], test: 'sh fetch.sh', check: 'grep -q \'"ok":true\' data.json',
    prompt: 'Run `sh fetch.sh` to download the API fixture into data.json. This network inspects TLS; the company CA is in certs/corp-ca.pem. Do not turn off certificate verification.',
    setup: (d, ctx) => w(d, withPolicy({
      'fetch.sh': 'curl -sSf https://api.corp.test/data.json -o data.json\n',
      'certs/corp-ca.pem': ctx && ctx.ca ? fs.readFileSync(ctx.ca, 'utf8') : '# start bench/proxy.js with --intercept to get the CA\n',
    })),
    solve: (d, ctx) => ctx.sh('CURL_CA_BUNDLE=certs/corp-ca.pem sh fetch.sh'),
  },
];
