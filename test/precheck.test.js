import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ROOT, shPath } from './helpers.js';
import { hostMatches } from '../src/bound/precheck.js';

const POLICY = {
  boundaries: [
    { kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp.internal', why: 'Public registries are blocked; use the internal mirror.' },
    { kind: 'host', pattern: '*.pypi.org', alternative: 'https://pypi.corp.internal/simple', why: 'Use the internal PyPI mirror.' },
    { kind: 'host', pattern: 'pypi.org', alternative: 'https://pypi.corp.internal/simple' },
    { kind: 'host', pattern: 'blocked.example' },
    { kind: 'host', pattern: 'ghcr.io' },
    { kind: 'program', pattern: 'docker', why: 'Docker is not available in this environment.' },
    { kind: 'command', pattern: 'terraform apply*', why: 'Applies run only in CI.' },
    { kind: 'git_push', pattern: 'main', why: 'main is protected; open a pull request.' },
    { kind: 'git_push', pattern: 'release/*', why: 'Release branches are protected.' },
  ],
};

function repoWith(files = {}, git = false) {
  return makeRepo({ git, files: { 'kerb.policy.json': JSON.stringify(POLICY), ...files } });
}

test('X1 curl to a blocked host → 77, not executed', () => {
  const repo = repoWith();
  const side = shPath(repo.home, 'side');
  const r = repo.kerb(['run', '--', `touch ${side} && curl https://blocked.example/x`]);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /^kerb: policy_blocked · blocked\.example is blocked here$/m);
  assert.equal(fs.existsSync(side), false);
});

test('X2 npm install with no .npmrc and the registry blocked → 77 naming the alternative', () => {
  const repo = repoWith();
  const r = repo.kerb(['check', '--', 'npm install left-pad']);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /registry\.npmjs\.org, which is blocked here/);
  assert.match(r.stderr, /next: use https:\/\/npm\.corp\.internal instead/);
});

test('X3 the same with .npmrc pointing at the mirror → allowed', () => {
  const repo = repoWith({ '.npmrc': 'registry=https://npm.corp.internal/\n' });
  assert.equal(repo.kerb(['check', '--', 'npm install left-pad']).code, 0);
  assert.equal(repo.kerb(['check', '--', 'npm i left-pad --registry=https://registry.npmjs.org']).code, 77);
});

test('X4 cd sub && npm i x uses sub/.npmrc', () => {
  const repo = repoWith({ 'sub/.npmrc': 'registry=https://npm.corp.internal/\n' });
  assert.equal(repo.kerb(['check', '--', 'cd sub && npm i x']).code, 0);
  assert.equal(repo.kerb(['check', '--', 'npm i x']).code, 77);
  const repo2 = repoWith({ '.npmrc': 'registry=https://npm.corp.internal/\n', 'sub/.npmrc': 'registry=https://registry.npmjs.org/\n' });
  assert.equal(repo2.kerb(['check', '--', 'cd sub && npm i x']).code, 77);
});

test('X5 pip install with PIP_INDEX_URL set to the mirror → allowed', () => {
  const repo = repoWith();
  assert.equal(repo.kerb(['check', '--', 'pip install requests']).code, 77);
  assert.equal(repo.kerb(['check', '--', 'pip install requests'], { env: { PIP_INDEX_URL: 'https://pypi.corp.internal/simple' } }).code, 0);
  assert.equal(repo.kerb(['check', '--', 'python3 -m pip install requests']).code, 77);
});

test('X6 git push origin main → 77; git push origin feature → allowed', () => {
  const repo = repoWith({}, true);
  const r = repo.kerb(['check', '--', 'git push origin main']);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /pushing to main is blocked here/);
  assert.match(r.stderr, /main is protected; open a pull request/);
  assert.equal(repo.kerb(['check', '--', 'git push origin feature']).code, 0);
  assert.equal(repo.kerb(['check', '--', 'git push origin HEAD:release/1.2']).code, 77);
  assert.equal(repo.kerb(['check', '--', 'git push -u origin feature:main']).code, 77);
});

test('X7 git push with no refspec on a protected current branch → 77', () => {
  const repo = repoWith({}, true);
  assert.equal(repo.kerb(['check', '--', 'git push']).code, 77);
  repo.git('checkout', '-q', '-b', 'feature');
  assert.equal(repo.kerb(['check', '--', 'git push']).code, 0);
  assert.equal(repo.kerb(['check', '--', 'git push origin HEAD']).code, 0);
});

test('X8 program docker blocks docker, docker ps and sudo docker run x', () => {
  const repo = repoWith();
  for (const c of ['docker', 'docker ps', 'sudo docker run x', '/usr/local/bin/docker images']) assert.equal(repo.kerb(['check', '--', c]).code, 77, c);
  assert.equal(repo.kerb(['check', '--', 'echo docker']).code, 0);
});

test('X9 command glob terraform apply* blocks apply and allows plan', () => {
  const repo = repoWith();
  assert.equal(repo.kerb(['check', '--', 'terraform apply -auto-approve']).code, 77);
  assert.equal(repo.kerb(['check', '--', 'terraform plan']).code, 0);
});

test('X10 host glob *.pypi.org matches files.pypi.org, not pypi.org.evil.example', () => {
  assert.equal(hostMatches('*.pypi.org', 'files.pypi.org'), true);
  assert.equal(hostMatches('*.pypi.org', 'a.b.pypi.org'), true);
  assert.equal(hostMatches('*.pypi.org', 'pypi.org'), false);
  assert.equal(hostMatches('*.pypi.org', 'pypi.org.evil.example'), false);
  assert.equal(hostMatches('registry.npmjs.org', 'REGISTRY.npmjs.org'), true);
  const repo = repoWith();
  assert.equal(repo.kerb(['check', '--', 'curl https://files.pypi.org/x']).code, 77);
  assert.equal(repo.kerb(['check', '--', 'curl https://pypi.org.evil.example/x']).code, 0);
});

test('X11 bash -c "npm i x" is checked', () => {
  const repo = repoWith();
  assert.equal(repo.kerb(['check', '--', 'bash -c "npm i x"']).code, 77);
});

test('X12 docker pull ghcr.io/a/b extracts ghcr.io', () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'ghcr.io' }] }) } });
  const r = repo.kerb(['check', '--', 'docker pull ghcr.io/a/b']);
  assert.equal(r.code, 77);
  assert.match(r.stderr, /ghcr\.io is blocked here/);
  assert.equal(repo.kerb(['check', '--', 'docker pull quay.io/a/b']).code, 0);
});

test('X13 no refusal message suggests a proxy or a workaround', () => {
  const banned = /proxy|workaround|work around|bypass|circumvent|vpn|--no-verify|--force|public mirror|disable/i;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'src'));
  let checked = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/next:\s*(['`"])((?:\\.|(?!\1).)*)\1/g)) {
      checked++;
      assert.ok(!banned.test(m[2]), `${path.basename(f)}: ${m[2]}`);
    }
    for (const m of text.matchAll(/const NEXT[A-Z_]* = (['`"])((?:\\.|(?!\1).)*)\1/g)) {
      checked++;
      assert.ok(!banned.test(m[2]), `${path.basename(f)}: ${m[2]}`);
    }
  }
  const rules = fs.readFileSync(path.join(ROOT, 'src/loop/rules.js'), 'utf8');
  for (const m of rules.matchAll(/['`]((?:change something|this failed twice|your files match|same failure|a service this needs looks)[^'`]*)['`]/g)) {
    checked++;
    assert.ok(!banned.test(m[1]), m[1]);
  }
  assert.ok(checked >= 7, `found ${checked} next templates`);
});

test('X14 suspected entries add a note and do not block', () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb', 'learned.jsonl'), `${JSON.stringify({ kind: 'host', pattern: 'sus.example', status: 'suspected', first_seen: Date.now(), last_seen: Date.now(), hits: 1, keys: ['k'], evidence_run: 'r1' })}\n`);
  const r = repo.kerb(['check', '--', 'curl https://sus.example/x']);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /^kerb: note · sus\.example may be blocked here \(seen 1 time\)$/m);
});
