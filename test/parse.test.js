import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCommand } from '../src/parse/tokenize.js';
import { classifyCommand, compileCheckCommands } from '../src/parse/classify-cmd.js';
import { commandHosts, explicitHosts, hostFromUrl, imageRegistry } from '../src/parse/hosts.js';

const cwd = '/repo';
const p = (c) => parseCommand(c, { cwd, home: '/home/u' });
const cls = (c, o) => classifyCommand(p(c), o);

test('P1 cd x && npm i left-pad → 2 segments; the second runs in x', () => {
  const r = p('cd x && npm i left-pad');
  assert.equal(r.segments.length, 2);
  assert.equal(r.segments[1].program, 'npm');
  assert.equal(r.segments[1].cwd, path.resolve('/repo/x'));
  assert.equal(r.segments[0].cwd, '/repo');
});

test('P2 FOO=1 npm i → program npm', () => {
  const s = p('FOO=1 npm i').segments[0];
  assert.equal(s.program, 'npm');
  assert.deepEqual(s.assigns, ['FOO']);
});

test('P3 sudo -E docker ps → program docker', () => {
  assert.equal(p('sudo -E docker ps').segments[0].program, 'docker');
  assert.equal(p('sudo -u root -E docker ps').segments[0].program, 'docker');
});

test('P4 env A=1 B=2 pip install x → program pip', () => {
  const s = p('env A=1 B=2 pip install x').segments[0];
  assert.equal(s.program, 'pip');
  assert.deepEqual(s.assigns, ['A', 'B']);
});

test('P5 bash -c "curl https://a.example" → host a.example', () => {
  const r = p('bash -c "curl https://a.example"');
  assert.equal(r.segments[0].program, 'curl');
  assert.deepEqual(commandHosts(r).map((h) => h.host), ['a.example']);
  assert.deepEqual(commandHosts(p(`sh -lc 'curl -fsS https://b.example/x'`)).map((h) => h.host), ['b.example']);
});

test('P6 a | b ; c || d → 4 segments', () => {
  assert.deepEqual(p('a | b ; c || d').segments.map((s) => s.program), ['a', 'b', 'c', 'd']);
});

test('P7 quoted "a && b" stays one argument', () => {
  const s = p('echo "a && b"').segments;
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].args, ['a && b']);
  assert.deepEqual(p("echo 'x;y' z\\;w").segments[0].args, ['x;y', 'z;w']);
});

test('P8 npm run dev & → class background', () => {
  assert.equal(cls('npm run dev &'), 'background');
  assert.equal(cls('nohup node server.js'), 'background');
  assert.equal(cls('npm test', { background: true }), 'background');
  assert.equal(cls('a & b'), 'other');
});

test('P9 npm test → check; grep x → query; npm install → other', () => {
  assert.equal(cls('npm test'), 'check');
  assert.equal(cls('grep x'), 'query');
  assert.equal(cls('npm install'), 'other');
  assert.equal(cls('cd pkg && npm test'), 'check');
  assert.equal(cls('cd src && grep -r foo .'), 'query');
  assert.equal(cls('npm run test:unit'), 'check');
  assert.equal(cls('npm run dev'), 'other');
  assert.equal(cls('python3 -m pytest -q'), 'check');
  assert.equal(cls('./gradlew test'), 'check');
  assert.equal(cls('mvn -q verify'), 'check');
  assert.equal(cls('npx prettier . --check'), 'check');
  assert.equal(cls('npm test | tail -5'), 'check');
});

test('P10 git diff --exit-code → query', () => {
  assert.equal(cls('git diff --exit-code'), 'query');
  assert.equal(cls('git -C sub status'), 'query');
  assert.equal(cls('git commit -m x'), 'other');
});

test('P11 unbalanced quotes → one opaque other segment', () => {
  const r = p('echo "oops');
  assert.equal(r.opaque, true);
  assert.equal(r.segments.length, 1);
  assert.equal(cls('echo "oops'), 'other');
  assert.equal(p("echo 'x").opaque, true);
  assert.equal(p('echo $(foo').opaque, true);
});

test('P12 timeout 5 npm test → program npm, class check', () => {
  const s = p('timeout 5 npm test').segments[0];
  assert.equal(s.program, 'npm');
  assert.equal(cls('timeout 5 npm test'), 'check');
  assert.equal(p('timeout -k 2 5s nice -n 5 time npm test').segments[0].program, 'npm');
});

test('P13 cloud CLIs are class other', () => {
  for (const c of ['aws s3 ls', 'terraform plan', 'kubectl get pods', 'gcloud compute list', 'az vm list', 'docker ps']) {
    assert.equal(cls(c), 'other', c);
  }
});

test('policy check_commands extend the check class', () => {
  const extra = compileCheckCommands(['just test', 'bazel test *']);
  assert.equal(cls('just test', { checkCommands: extra }), 'check');
  assert.equal(cls('just test --verbose', { checkCommands: extra }), 'check');
  assert.equal(cls('bazel test //...', { checkCommands: extra }), 'check');
  assert.equal(cls('bazel build //...', { checkCommands: extra }), 'other');
});

test('redirections, heredocs and comments', () => {
  const r = p('npm test > out.log 2>&1');
  assert.deepEqual(r.segments[0].args, ['test']);
  const h = p('cat <<EOF > f.txt\ndocker run evil\ncurl https://x.example\nEOF\necho done');
  assert.deepEqual(h.segments.map((s) => s.program), ['cat', 'echo']);
  assert.deepEqual(p('ls # docker ps').segments.map((s) => s.program), ['ls']);
  assert.deepEqual(p('echo $(docker ps) "$(a "b")"').segments.map((s) => s.program), ['echo']);
});

test('hosts: URLs only count for network programs; git remotes; images; flags', () => {
  assert.deepEqual(explicitHosts(p('echo https://blocked.example').segments[0]), []);
  assert.deepEqual(explicitHosts(p('git commit -m "see https://blocked.example"').segments[0]), []);
  const clone = explicitHosts(p('git clone git@github.com:a/b.git').segments[0]);
  assert.deepEqual(clone.map((h) => h.host), ['github.com']);
  const push = explicitHosts(p('git push origin main').segments[0], { resolveGitRemote: () => 'https://git.corp.example/r.git' });
  assert.deepEqual(push.map((h) => h.host), ['git.corp.example']);
  assert.deepEqual(explicitHosts(p('curl -o out.json -H "A: b" api.example.com/x').segments[0]).map((h) => h.host), ['api.example.com']);
  assert.deepEqual(explicitHosts(p('pip install -i https://pypi.corp/simple x').segments[0]).map((h) => h.host), ['pypi.corp']);
  assert.deepEqual(explicitHosts(p('npm i --registry=https://npm.corp.internal x').segments[0]).map((h) => h.host), ['npm.corp.internal']);
  assert.equal(imageRegistry('ghcr.io/a/b'), 'ghcr.io');
  assert.equal(imageRegistry('library/node'), 'docker.io');
  assert.equal(imageRegistry('node:20'), 'docker.io');
  assert.equal(imageRegistry('localhost:5000/x'), 'localhost');
  assert.deepEqual(explicitHosts(p('docker run --rm -e A=1 -p 80:80 quay.io/x/y cmd').segments[0]).map((h) => h.host), ['quay.io']);
  assert.equal(hostFromUrl('https://user:pw@Example.COM:8443/x'), 'example.com');
  assert.equal(hostFromUrl('ssh://git@host.example/x'), 'host.example');
});
