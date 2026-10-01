// EN · Environment classifier, TLS fixes and `kerb doctor tls` (KERB-V2 8.3, tests EN1–EN9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { makeRepo, records, inproc, shPath, ROOT } from './helpers.js';
import { classifyEnvironment, envFixLines, tlsSetting, toolFor, caBundleFor, PROXY_PAGES } from '../src/insight/envclass.js';
import { analyzeText } from '../src/loop/fingerprint.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { KerbError } from '../src/util/core.js';
import { setTrustStoreForTests, candidates } from '../src/cli/doctor-tls.js';
import { lintPolicy, mergeLayers } from '../src/bound/policy.js';

const FIX = path.join(ROOT, 'test/fixtures/env');
const read = (...p) => fs.readFileSync(path.join(FIX, ...p), 'utf8');
const BUNDLE = '/etc/company/ca.pem';

test('EN1 each TLS signature → environment/tls_interception', () => {
  const files = fs.readdirSync(path.join(FIX, 'tls'));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const env = classifyEnvironment(read('tls', f));
    assert.equal(env && env.subtype, 'tls_interception', f);
    assert.equal(analyzeText(read('tls', f)).kind, 'environment', f);
  }
  // End to end: recorded with failure_kind and subtype.
  const repo = makeRepo({ git: true });
  const r = repo.kerb(['run', '--class', 'check', '--', `cat ${shPath(FIX, 'tls', 'node-npm.txt')}; exit 1`]);
  assert.equal(r.code, 1);
  const end = records(repo.dir).find((x) => x.type === 'end');
  assert.equal(end.failure_kind, 'environment');
  assert.equal(end.env_subtype, 'tls_interception');
  assert.match(r.stderr, /^kerb: environment · TLS interception/m);
});

test('EN2 environment failures never count for loops', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const ran = shPath(repo.home, 'ran');
  for (let i = 0; i < 5; i++) {
    const r = repo.kerb(['run', '--class', 'check', '--', `echo x >> ${ran}; cat ${shPath(FIX, 'tls', 'curl.txt')}; exit 1`]);
    assert.equal(r.code, 1, `attempt ${i + 1} ran`);
    assert.doesNotMatch(r.stderr, /identical_retry|breaker_open/);
  }
  assert.equal(fs.readFileSync(ran, 'utf8').trim().split('\n').length, 5);
  assert.equal(records(repo.dir).filter((x) => x.type === 'refusal').length, 0);
  // An environment run breaks a breaker streak like a policy denial does.
  const proxy = makeRepo({ git: true });
  for (let i = 0; i < 3; i++) proxy.kerb(['run', '--class', 'check', '--', `cat ${shPath(FIX, 'proxy', 'squid-access-denied.txt')}; exit 22`]);
  assert.ok(records(proxy.dir).filter((x) => x.type === 'end').every((e) => e.env_subtype === 'proxy_page'));
});

test('EN3 with tls.ca_bundle, the fix line names the right setting per tool', () => {
  const want = {
    npm: /NODE_EXTRA_CA_CERTS=\/etc\/company\/ca\.pem .*npm config set cafile \/etc\/company\/ca\.pem/,
    node: /NODE_EXTRA_CA_CERTS=\/etc\/company\/ca\.pem/,
    pip: /PIP_CERT=\/etc\/company\/ca\.pem/,
    python: /REQUESTS_CA_BUNDLE=\/etc\/company\/ca\.pem/,
    uv: /SSL_CERT_FILE=\/etc\/company\/ca\.pem/,
    curl: /SSL_CERT_FILE=\/etc\/company\/ca\.pem .*CURL_CA_BUNDLE=/,
    git: /GIT_SSL_CAINFO=\/etc\/company\/ca\.pem/,
    aws: /AWS_CA_BUNDLE=\/etc\/company\/ca\.pem/,
    go: /SSL_CERT_FILE=\/etc\/company\/ca\.pem/,
  };
  for (const [tool, re] of Object.entries(want)) assert.match(tlsSetting(tool, BUNDLE), re, tool);
  assert.equal(toolFor(['cd', 'npm'], null), 'npm');
  assert.equal(toolFor(['./gradlew'], null), 'java');
  assert.equal(toolFor(['make'], 'go'), 'go', 'falls back to the signature');
  const java = envFixLines({ subtype: 'tls_interception', tool: 'java' }, { programs: ['mvn'], caBundle: { path: BUNDLE, source: 'org policy v3' } });
  assert.match(java[1], /keytool/);
  const pip = envFixLines({ subtype: 'tls_interception', tool: 'python' }, { programs: ['pip'], caBundle: { path: BUNDLE, source: 'org policy v3' } });
  assert.equal(pip[1], `      next: retry with PIP_CERT=${BUNDLE} for this command (company CA bundle from org policy v3)`);
  // End to end through `kerb run` with the user's config, and through the Claude hook.
  const repo = makeRepo({ git: true, config: { 'tls.ca_bundle': BUNDLE } });
  const r = repo.kerb(['run', '--', `node -e "console.error('Error: SELF_SIGNED_CERT_IN_CHAIN'); process.exit(1)"`]);
  assert.match(r.stderr, /next: retry with NODE_EXTRA_CA_CERTS=\/etc\/company\/ca\.pem for this command \(company CA bundle from your Kerb config\)/);
  const p = { session_id: 's', transcript_path: '/t', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: 'pip install requests' }, tool_use_id: 'p1' };
  repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) });
  const post = repo.kerb(['hook', 'claude', 'post-failure'], { input: JSON.stringify({ ...p, error: `Exit code 1\n${read('tls', 'python-pip.txt')}` }) });
  assert.match(JSON.parse(post.stdout).hookSpecificOutput.additionalContext, /kerb: environment · TLS interception[^\n]*\n {6}next: retry with PIP_CERT=\/etc\/company\/ca\.pem/);
});

test('EN4 without a CA bundle, the generic line', () => {
  const lines = envFixLines({ subtype: 'tls_interception', tool: 'node' }, { programs: ['npm'] });
  assert.equal(lines[1], "      next: TLS interception detected; the company CA isn't configured for this tool. Ask the user, or run `kerb doctor tls`");
  const repo = makeRepo({ git: true });
  const r = repo.kerb(['run', '--json', '--', `cat ${shPath(FIX, 'tls', 'go-get.txt')}; exit 1`]);
  assert.equal(r.json.environment.subtype, 'tls_interception');
  assert.match(r.json.environment.fix[1], /isn't configured for this tool/);
});

test('EN5 no message anywhere suggests disabling verification', () => {
  const BAD = /NODE_TLS_REJECT_UNAUTHORIZED|--insecure|\bsslVerify\b|--trusted-host|strict-ssl|PYTHONHTTPSVERIFY|GIT_SSL_NO_VERIFY|verify\s*=\s*False|rejectUnauthorized\s*:\s*false|(^|\s)-k(\s|$)/i;
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'templates'));
  for (const f of files) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), BAD, f);
  const tools = ['npm', 'node', 'bun', 'pip', 'python', 'uv', 'curl', 'git', 'aws', 'go', 'java', null];
  for (const subtype of ['tls_interception', 'proxy_page', 'auth_expired']) {
    for (const tool of tools) {
      for (const caBundle of [null, { path: BUNDLE, source: 'x' }]) {
        for (const args of [['install'], ['run', 'x']]) {
          const text = envFixLines({ subtype, tool }, { programs: tool ? [tool] : [], args, caBundle }).join('\n');
          assert.doesNotMatch(text, BAD, `${subtype} ${tool}`);
        }
      }
    }
  }
});

test('EN6 proxy page signatures come only from the fixture set', () => {
  const fixtures = fs.readdirSync(path.join(FIX, 'proxy')).map((f) => f.replace(/\.txt$/, ''));
  assert.deepEqual(PROXY_PAGES.map((p) => p.id).sort(), fixtures.sort(), 'one capture per signature, and no signature without one');
  for (const id of fixtures) {
    const env = classifyEnvironment(read('proxy', `${id}.txt`));
    assert.equal(env.subtype, 'proxy_page', id);
    assert.equal(env.signature, id);
    assert.equal(envFixLines(env)[1], '      next: Blocked by the corporate proxy; tell the user which URL you need');
  }
  assert.equal(classifyEnvironment(read('generic-403.txt')), null, 'an ordinary 403 is not a proxy page');
});

test('EN7 auth_expired is classified', () => {
  const cases = [
    'An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is expired',
    'botocore.exceptions.ClientError: An error occurred (ExpiredTokenException) when calling the AssumeRole operation',
    'To get started with GitHub CLI, please run:  gh auth login',
    'HTTP 401: Bad credentials (https://api.github.com/graphql)',
    "AADSTS700082: The refresh token has expired due to inactivity. Please run 'az login' to setup account.",
    'Error: 401 Unauthorized: token has expired',
  ];
  for (const c of cases) assert.equal(classifyEnvironment(c)?.subtype, 'auth_expired', c);
  assert.equal(envFixLines({ subtype: 'auth_expired' })[1], '      next: Credentials expired; ask the user to re-authenticate');
  for (const ok of ['AssertionError: expected 401 to equal 200', 'FAIL test/login.test.js › rejects an expired cookie']) {
    assert.equal(classifyEnvironment(ok), null, ok);
  }
});

test('EN8 doctor tls asks before writing', async () => {
  const corp = read('corp-root-ca.pem');
  const repo = makeRepo({ git: true });
  const bundle = path.join(repo.home, '.kerb', 'ca-bundle.pem');
  setTrustStoreForTests(() => [{ pem: corp, source: 'test store' }, { pem: tls.rootCertificates[0], source: 'test store' }]);
  try {
    const list = await inproc(repo, ['doctor', 'tls', '--json', '--dry-run']);
    assert.equal(list.code, 0);
    assert.equal(list.json.candidates.length, 1, 'public roots are not candidates');
    assert.match(list.json.candidates[0].subject, /Example Corp TLS Inspection Root CA/);
    // In-process, so simulate "no terminal" rather than open the developer's /dev/tty.
    setHumanOverrideForTests(() => { throw new KerbError(64, 'human_only · no terminal'); });
    const refused = await inproc(repo, ['doctor', 'tls']);
    assert.equal(refused.code, 64, 'no terminal: nothing written');
    assert.equal(fs.existsSync(bundle), false);
    assert.equal(fs.existsSync(path.join(repo.home, '.kerb', 'config.json')), false);
    setHumanOverrideForTests(() => true);
    const ok = await inproc(repo, ['doctor', 'tls', '--json']);
    assert.equal(ok.code, 0);
    assert.equal(ok.json.written, true);
    const text = fs.readFileSync(bundle, 'utf8');
    assert.ok(text.includes(corp.trim().split('\n')[1]), 'the company CA is in the bundle');
    assert.ok(text.includes(tls.rootCertificates[0].trim().split('\n')[1]), 'public roots too');
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo.home, '.kerb', 'config.json'), 'utf8'))['tls.ca_bundle'], bundle);
  } finally {
    setTrustStoreForTests(null);
    setHumanOverrideForTests(null);
  }
  assert.equal(candidates([{ pem: corp, source: 'x' }], Date.parse('2050-01-01')).length, 0, 'expired CAs are skipped');
});

test('EN9 Bun follows the VERIFY decision: bunfig cafile for installs, NODE_EXTRA_CA_CERTS otherwise', () => {
  assert.equal(tlsSetting('bun', BUNDLE, { args: ['install'] }), `cafile = "${BUNDLE}" under [install] in bunfig.toml`);
  assert.equal(tlsSetting('bun', BUNDLE, { args: ['add', 'x'] }), `cafile = "${BUNDLE}" under [install] in bunfig.toml`);
  assert.equal(tlsSetting('bun', BUNDLE, { args: ['run', 'dev'] }), `NODE_EXTRA_CA_CERTS=${BUNDLE} for this command`);
});

test('tls.ca_bundle comes from managed, org or user config, never the repo policy; sanctioned fixes', () => {
  assert.ok(lintPolicy({ tls: { ca_bundle: '/x.pem' } }, { layer: 'repo' }).some((p) => /ignored in kerb\.policy\.json/.test(p.message)));
  assert.ok(lintPolicy({ tls: { ca_bundle: 'rel.pem' } }).some((p) => p.level === 'error'));
  const merged = mergeLayers([
    { name: 'org', version: 3, policy: { tls: { ca_bundle: '/org/ca.pem' }, environment_fixes: { auth_expired: 'run corp-login, then retry' } }, source: 'org policy v3' },
    { name: 'repo', policy: { tls: { ca_bundle: '/evil.pem' }, environment_fixes: { auth_expired: 'x', proxy_page: 'file a request at go/egress' } }, source: 'repo policy (kerb.policy.json)' },
  ]);
  assert.deepEqual(merged.tls_ca_bundle, { path: '/org/ca.pem', source: 'org policy v3' });
  assert.equal(merged.environment_fixes.auth_expired.text, 'run corp-login, then retry');
  assert.equal(merged.environment_fixes.proxy_page.source, 'repo policy (kerb.policy.json)');
  const repoOnly = mergeLayers([{ name: 'repo', policy: { tls: { ca_bundle: '/evil.pem' } }, source: 'repo' }]);
  assert.equal(caBundleFor({ values: {}, managed: null }, repoOnly), null);
  assert.deepEqual(caBundleFor({ values: { 'tls.ca_bundle': '/u.pem' }, managed: { tls: { ca_bundle: '/m.pem' } } }, merged), { path: '/m.pem', source: "your organisation's managed config" });
  const locked = mergeLayers([{ name: 'repo', policy: { environment_fixes: { proxy_page: 'x' } }, source: 'repo' }], { lockRepoAlternatives: true });
  assert.deepEqual(locked.environment_fixes, {});
  const lines = envFixLines({ subtype: 'auth_expired' }, { sanctioned: merged.environment_fixes.auth_expired });
  assert.equal(lines[1], '      next: run corp-login, then retry (from org policy v3)');
});
