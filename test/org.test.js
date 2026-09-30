import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeRepo, inproc, tmpDir, ROOT, KERB, runKerb } from './helpers.js';
import { setManagedConfigPathForTests } from '../src/config.js';
import { orgLayer, refreshOrg, signBundle } from '../src/bound/org.js';
import { generateKeyPairSync } from 'node:crypto';

function keys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64'),
  };
}

/** A local bundle server. `handler(req, res)` may be swapped per test. */
async function server(handler) {
  const s = http.createServer((req, res) => s.handler(req, res));
  s.handler = handler;
  s.requests = [];
  const orig = s.handler;
  void orig;
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${s.address().port}/bundle.json`;
  return s;
}

/** Run fn with HOME and the managed config pointed at temp locations. */
async function withManaged(managed, fn) {
  const home = tmpDir('kerb-home-');
  const dir = tmpDir();
  const file = path.join(dir, 'managed.json');
  fs.writeFileSync(file, JSON.stringify(managed));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  setManagedConfigPathForTests(file);
  try {
    return await fn({ home, managedFile: file });
  } finally {
    setManagedConfigPathForTests(null);
    process.env.HOME = oldHome;
  }
}

const POLICY = { version: 1, boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://npm.corp', why: 'mirror' }] };

test('O1 keygen, sign, verify round trip', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(POLICY));
  const k = runKerb(['--json', 'policy', 'keygen', '--out', 'keys'], { cwd: dir });
  assert.equal(k.code, 0);
  assert.equal(fs.statSync(path.join(dir, 'keys/kerb-org.key')).mode & 0o777, 0o600);
  const s = runKerb(['policy', 'sign', 'policy.json', '--key', 'keys/kerb-org.key', '--bundle-version', '42', '--out', 'b.json'], { cwd: dir });
  assert.equal(s.code, 0, s.stderr);
  const v = runKerb(['--json', 'policy', 'verify', 'b.json', '--pub', 'keys/kerb-org.pub'], { cwd: dir });
  assert.equal(v.code, 0);
  assert.equal(v.json.bundle_version, 42);
  // A different key fails verification.
  runKerb(['policy', 'keygen', '--out', 'other'], { cwd: dir });
  assert.equal(runKerb(['policy', 'verify', 'b.json', '--pub', 'other/kerb-org.pub'], { cwd: dir }).code, 1);
  assert.equal(runKerb(['policy', 'keygen', '--out', 'keys'], { cwd: dir }).code, 64, 'never overwrites a key');
});

test('O2 a tampered bundle is rejected; the previous verified bundle stays in use', async () => {
  const k = keys();
  const good = JSON.stringify(signBundle(POLICY, k.priv, 1));
  const tampered = JSON.parse(JSON.stringify(signBundle(POLICY, k.priv, 2)));
  tampered.payload = Buffer.from(JSON.stringify({ bundle_version: 2, policy: { boundaries: [] } })).toString('base64');
  const s = await server((req, res) => { res.end(good); });
  try {
    await withManaged({ org: { bundle_url: s.url, public_key: k.pub } }, async ({ managedFile }) => {
      const managed = JSON.parse(fs.readFileSync(managedFile, 'utf8'));
      assert.equal((await refreshOrg(managed, { force: true })).updated, true);
      assert.equal(orgLayer(managed).status.version, 1);
      s.handler = (req, res) => res.end(JSON.stringify(tampered));
      const r = await refreshOrg(managed, { force: true });
      assert.match(r.error, /does not verify/);
      const layer = orgLayer(managed);
      assert.equal(layer.status.version, 1);
      assert.equal(layer.layer.policy.boundaries.length, 1);
    });
  } finally {
    s.close();
  }
});

test('O3 ETag 304 → the cache is used', async () => {
  const k = keys();
  const body = JSON.stringify(signBundle(POLICY, k.priv, 7));
  const seen = [];
  const s = await server((req, res) => {
    seen.push(req.headers['if-none-match'] || null);
    if (req.headers['if-none-match'] === '"v7"') { res.statusCode = 304; res.end(); return; }
    res.setHeader('etag', '"v7"');
    res.end(body);
  });
  try {
    await withManaged({ org: { bundle_url: s.url, public_key: k.pub } }, async ({ managedFile }) => {
      const managed = JSON.parse(fs.readFileSync(managedFile, 'utf8'));
      await refreshOrg(managed, { force: true });
      const r = await refreshOrg(managed, { force: true });
      assert.equal(r.notModified, true);
      assert.deepEqual(seen, [null, '"v7"']);
      assert.equal(orgLayer(managed).status.version, 7);
    });
  } finally {
    s.close();
  }
});

test('O4 offline → the cached bundle is used and status says so; O5 an expired cache is still used', async () => {
  const k = keys();
  const s = await server((req, res) => res.end(JSON.stringify(signBundle(POLICY, k.priv, 3))));
  await withManaged({ org: { bundle_url: s.url, public_key: k.pub, max_cache_hours: 1 } }, async ({ managedFile }) => {
    const managed = JSON.parse(fs.readFileSync(managedFile, 'utf8'));
    await refreshOrg(managed, { force: true });
    await new Promise((r) => s.close(r));
    const r = await refreshOrg(managed, { force: true });
    assert.ok(r.error);
    const o = orgLayer(managed);
    assert.equal(o.status.offline, true);
    assert.equal(o.status.version, 3);
    assert.ok(o.layer);
    const later = orgLayer(managed, Date.now() + 2 * 3_600_000);
    assert.equal(later.status.stale, true);
    assert.ok(later.layer, 'expired cache still used');
    assert.equal(later.layer.policy.boundaries[0].pattern, 'registry.npmjs.org');
  });
});

test('O4 the org layer blocks with its version as the source', async () => {
  const k = keys();
  const s = await server((req, res) => res.end(JSON.stringify(signBundle(POLICY, k.priv, 42))));
  try {
    await withManaged({ org: { bundle_url: s.url, public_key: k.pub } }, async ({ home }) => {
      const repo = makeRepo();
      repo.home = home;
      const r = await inproc(repo, ['check', '--', 'npm install left-pad']);
      assert.equal(r.code, 77);
      assert.match(r.stderr, /source: org policy v42 · mirror/);
      assert.match(r.stderr, /next: use https:\/\/npm\.corp instead$/m);
    });
  } finally {
    s.close();
  }
});

test('O6 a fetch takes no more than 2 s', async () => {
  const k = keys();
  const s = await server(() => { /* never answers */ });
  try {
    await withManaged({ org: { bundle_url: s.url, public_key: k.pub } }, async ({ managedFile }) => {
      const managed = JSON.parse(fs.readFileSync(managedFile, 'utf8'));
      const t0 = Date.now();
      const r = await refreshOrg(managed, { force: true });
      const took = Date.now() - t0;
      assert.ok(r.error);
      assert.ok(took < 2600, `took ${took}ms`);
    });
  } finally {
    s.closeAllConnections?.();
    s.close();
  }
});

test('O7 no network call when bundle_url is unset', async () => {
  const repo = makeRepo();
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...a) => { calls++; return orig(...a); };
  try {
    await inproc(repo, ['check', '--', 'npm install x']);
    await inproc(repo, ['run', '--', 'true']);
    await inproc(repo, ['map']);
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(calls, 0);
});

test('O8 the template repo signs a sample policy in a dry run', () => {
  const dir = tmpDir();
  const keysDir = path.join(dir, 'keys');
  runKerb(['policy', 'keygen', '--out', keysDir]);
  const out = path.join(dir, 'kerb-bundle.json');
  const r = spawnSync('sh', [path.join(ROOT, 'templates/agent-policy/scripts/sign.sh')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      KERB_CMD: `${process.execPath} ${KERB}`,
      SIGNING_KEY_FILE: path.join(keysDir, 'kerb-org.key'),
      PUBLIC_KEY: fs.readFileSync(path.join(keysDir, 'kerb-org.pub'), 'utf8').trim(),
      BUNDLE_VERSION: '5',
      OUT: out,
    },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /signed .* \(bundle v5\)/);
  assert.ok(fs.existsSync(out));
});

test('Z3 only bound/org.js and telemetry/otlp.js import network modules or call fetch', () => {
  const allowed = new Set(['src/bound/org.js', 'src/telemetry/otlp.js']);
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'src'));
  walk(path.join(ROOT, 'bin'));
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    const text = fs.readFileSync(f, 'utf8');
    const net = /from\s+['"]node:(http|https|net|dns|tls|http2|dgram)['"]|import\(\s*['"]node:(http|https|net|dns|tls|http2|dgram)['"]|require\(\s*['"](node:)?(http|https|net|dns|tls|http2|dgram)['"]/.test(text);
    const fetchCall = /(^|[^.\w])fetch\s*\(|globalThis\.fetch/.test(text);
    if (!allowed.has(rel)) {
      assert.ok(!net, `${rel} imports a network module`);
      assert.ok(!fetchCall, `${rel} calls fetch`);
    }
  }
});
