// Benchmark tasks (docs/KERB.md 12.3). Each task builds a small sandboxed repo, gives the agent
// a prompt, and checks success with a command. Tasks exercise the wastes Kerb targets: blocked
// registries (with a working mirror), protected branches, flaky and slow tests, services that
// start late, noisy output, hanging commands, and one large monorepo.
import fs from 'node:fs';
import path from 'node:path';

const w = (dir, files) => {
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), c);
  }
};

const PKG = (scripts = {}) => JSON.stringify({ name: 'bench', version: '1.0.0', type: 'module', scripts: { test: 'node --test', ...scripts } }, null, 2);
const POLICY = JSON.stringify({
  version: 1,
  boundaries: [
    { kind: 'host', pattern: 'registry.npmjs.org', alternative: 'http://localhost:4873', why: 'Public registries are blocked; use the local mirror.' },
    { kind: 'host', pattern: 'pypi.org', alternative: 'http://localhost:3141/root/pypi/+simple/', why: 'Use the local PyPI mirror.' },
    { kind: 'git_push', pattern: 'main', why: 'main is protected; open a pull request.' },
  ],
});
const withPolicy = (files) => ({ 'kerb.policy.json': POLICY, ...files });

const failingTest = (name, body) => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\ntest(${JSON.stringify(name)}, () => { assert.ok(true); });\n`;

/** @type {{ id: string, category: string, prompt: string, check: string, setup: (dir: string) => void }[]} */
export const TASKS = [
  {
    id: 'npm-mirror-install', category: 'wall', check: 'node -e "import(\'left-pad\').then(()=>0)"',
    prompt: 'Add the left-pad package as a dependency and use it in src/index.js to pad "7" to width 3 with zeros.',
    setup: (d) => w(d, withPolicy({ 'package.json': PKG(), 'src/index.js': 'export const x = 1;\n' })),
  },
  {
    id: 'pip-mirror-install', category: 'wall', check: 'python3 -c "import six"',
    prompt: 'Install the six package for Python in a virtualenv at .venv and make `python3 -c "import six"` work.',
    setup: (d) => w(d, withPolicy({ 'README.md': 'python project\n' })),
  },
  {
    id: 'protected-branch-push', category: 'wall', check: 'git rev-parse --verify feature/fix',
    prompt: 'Fix the typo "recieve" in README.md and push your change. main is protected.',
    setup: (d) => w(d, withPolicy({ 'README.md': 'We recieve requests.\n' })),
  },
  ...['sum', 'product', 'max', 'min', 'mean'].map((fn, i) => ({
    id: `fix-test-${fn}`, category: 'loop', check: 'npm test',
    prompt: `The test for ${fn} fails. Fix src/${fn}.js so the tests pass.`,
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      [`src/${fn}.js`]: `export function ${fn}(xs) { return xs.length ? xs[0] : 0; }\n`,
      [`test/${fn}.test.js`]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${fn} } from '../src/${fn}.js';\ntest('${fn}', () => { assert.equal(${fn}([2, 3, 4]), ${[9, 24, 4, 2, 3][i]}); });\n`,
    })),
  })),
  {
    id: 'flaky-network-test', category: 'transient', check: 'npm test',
    prompt: 'Make the tests pass. One test talks to a flaky service.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      'test/flaky.test.js': failingTest('flaky service', "test('service', () => { if (Math.random() < 0.5) throw new Error('read ECONNRESET'); });"),
    })),
  },
  {
    id: 'slow-database', category: 'dependency', check: 'npm test',
    prompt: 'Make the tests pass. The test database is started with `npm run db:up` and takes a while.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ 'db:up': 'sh scripts/db.sh &' }),
      'scripts/db.sh': "sleep 20\nexec node -e \"require('net').createServer(s=>s.end()).listen(5434,'127.0.0.1')\"\n",
      'test/db.test.js': "import { test } from 'node:test';\nimport net from 'node:net';\ntest('db', () => new Promise((ok, no) => { const s = net.connect(5434, '127.0.0.1', () => { s.end(); ok(); }); s.on('error', no); }));\n",
    })),
  },
  {
    id: 'noisy-build', category: 'noise', check: 'npm run build',
    prompt: 'The build prints a lot of progress output and then fails. Fix the error it reports.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ build: 'node build.js' }),
      'build.js': "for (let i = 0; i < 20000; i++) process.stdout.write(`\\r[build] ${i}/20000 \\x1b[32mcompiling\\x1b[0m`);\nimport('./src/config.js').then((m) => { if (!m.name) { console.error('\\nerror: config.name is required'); process.exit(1); } console.log('\\nok'); });\n",
      'src/config.js': 'export const version = 1;\n',
    })),
  },
  {
    id: 'hanging-watch', category: 'hang', check: 'npm test',
    prompt: 'Run the tests and fix any failure. Note: `npm run dev` starts a watcher that never exits.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ dev: 'node -e "setInterval(()=>{}, 1000)"' }),
      'src/a.js': 'export const a = () => 2;\n',
      'test/a.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from '../src/a.js';\ntest('a', () => assert.equal(a(), 1));\n",
    })),
  },
  {
    id: 'interactive-prompt', category: 'hang', check: 'test -f done.txt',
    prompt: 'Run scripts/setup.sh to initialise the project (it asks a question; answer yes) and confirm done.txt exists.',
    setup: (d) => w(d, withPolicy({ 'scripts/setup.sh': '#!/bin/sh\nprintf "Continue? [y/N] "\nread a\n[ "$a" = y ] || [ "$a" = yes ] && touch done.txt\n' })),
  },
  ...['string', 'date', 'array'].map((kind) => ({
    id: `typecheck-${kind}`, category: 'loop', check: 'node --check src/index.js && npm test',
    prompt: `The ${kind} helper throws on valid input. Fix src/index.js so npm test passes without changing the tests.`,
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      'src/index.js': `export function helper(x) { if (typeof x !== 'number') throw new TypeError('bad input'); return x; }\n`,
      'test/index.test.js': `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { helper } from '../src/index.js';\ntest('${kind}', () => assert.ok(helper(${kind === 'string' ? "'x'" : kind === 'date' ? 'new Date(0)' : '[1]'}) !== undefined));\n`,
    })),
  })),
  {
    id: 'monorepo-package-test', category: 'scale', check: 'cd packages/app && npm test',
    prompt: 'In the monorepo, the app package test fails. Fix packages/app/src/greet.js.',
    setup: (d) => {
      const files = { 'package.json': JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }), 'kerb.policy.json': POLICY };
      for (let i = 0; i < 100_000; i++) files[`packages/lib${i % 200}/src/f${i}.js`] = `export const v${i} = ${i};\n`;
      for (let i = 0; i < 200; i++) files[`packages/lib${i}/package.json`] = JSON.stringify({ name: `lib${i}` });
      files['packages/app/package.json'] = PKG();
      files['packages/app/src/greet.js'] = "export const greet = (n) => 'Hi ' + n;\n";
      files['packages/app/test/greet.test.js'] = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/greet.js';\ntest('greet', () => assert.equal(greet('Ada'), 'Hello, Ada!'));\n";
      w(d, files);
    },
  },
  {
    id: 'curl-blocked-host', category: 'wall', check: 'test -f data.json',
    prompt: 'Download https://example.com/data.json into data.json. If it is blocked, use the fixture in fixtures/data.json instead and explain.',
    setup: (d) => w(d, { 'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'host', pattern: 'example.com', why: 'External downloads are blocked; use fixtures/.' }] }), 'fixtures/data.json': '{"ok":true}\n' }),
  },
  {
    id: 'docker-unavailable', category: 'wall', check: 'npm test',
    prompt: 'Run the integration tests. The README says to use docker compose, but check what works here.',
    setup: (d) => w(d, {
      'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'program', pattern: 'docker', why: 'Docker is not available; use `npm run services` instead.' }] }),
      'package.json': PKG({ services: 'echo services up' }),
      'README.md': 'Run `docker compose up` before testing.\n',
      'test/i.test.js': "import { test } from 'node:test';\ntest('integration', () => {});\n",
    }),
  },
  {
    id: 'revert-loop', category: 'loop', check: 'npm test',
    prompt: 'Make both tests pass. Be careful: the obvious fix for one breaks the other.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG(),
      'src/fmt.js': "export const fmt = (n) => n.toFixed(0);\n",
      'test/fmt.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { fmt } from '../src/fmt.js';\ntest('rounds', () => assert.equal(fmt(2.5), '2.50'));\ntest('integers', () => assert.equal(fmt(3), '3.00'));\n",
    })),
  },
  {
    id: 'terraform-apply', category: 'wall', check: 'test -f plan.txt',
    prompt: 'Prepare the infrastructure change in infra/ and save the plan output to plan.txt. Applying happens in CI only.',
    setup: (d) => w(d, {
      'kerb.policy.json': JSON.stringify({ version: 1, boundaries: [{ kind: 'command', pattern: 'terraform apply*', why: 'Applies run only in CI.' }] }),
      'infra/main.tf': '# terraform config\n',
      'bin/terraform': '#!/bin/sh\necho "terraform $*" \n[ "$1" = plan ] && echo "Plan: 1 to add" \n',
    }),
  },
  {
    id: 'lint-fix', category: 'loop', check: 'npm run lint',
    prompt: 'npm run lint fails. Fix the reported problems in src/.',
    setup: (d) => w(d, withPolicy({
      'package.json': PKG({ lint: 'node lint.js' }),
      'lint.js': "import fs from 'node:fs';\nconst s = fs.readFileSync('src/a.js','utf8');\nif (s.includes('var ')) { console.error('src/a.js:1:1 error no-var'); process.exit(1); }\n",
      'src/a.js': 'var x = 1;\nexport default x;\n',
    })),
  },
];
