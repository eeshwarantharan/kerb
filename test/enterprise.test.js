import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc, tmpDir } from './helpers.js';
import { managedConfigPath, setManagedConfigPathForTests, loadConfig, setUserConfig } from '../src/config.js';
import { setHumanOverrideForTests } from '../src/bound/human.js';
import { orgLayer } from '../src/bound/org.js';

function withManaged(obj, home, fn) {
  const file = path.join(tmpDir(), 'managed.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  setManagedConfigPathForTests(file);
  return Promise.resolve().then(fn).finally(() => {
    setManagedConfigPathForTests(null);
    process.env.HOME = oldHome;
  });
}

test('E1 the managed config is found at each OS path', () => {
  assert.equal(managedConfigPath('linux'), '/etc/kerb/managed.json');
  assert.equal(managedConfigPath('darwin'), '/Library/Application Support/Kerb/managed.json');
  assert.equal(managedConfigPath('win32', { ProgramData: 'C:\\ProgramData' }), path.join('C:\\ProgramData', 'Kerb', 'managed.json'));
});

test('E2 managed defaults override user config', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, '.kerb'));
  fs.writeFileSync(path.join(home, '.kerb/config.json'), JSON.stringify({ recap: 'on', budget: 5000 }));
  await withManaged({ defaults: { recap: 'off' } }, home, () => {
    const c = loadConfig();
    assert.equal(c.values.recap, 'off');
    assert.equal(c.values.budget, 5000, 'other user values stay');
  });
});

test('E3 locked keys cannot be changed', async () => {
  const repo = makeRepo();
  await withManaged({ defaults: { telemetry: 'on' }, locked: ['telemetry'] }, repo.home, async () => {
    assert.throws(() => setUserConfig('telemetry', 'off'), /locked by your organisation/);
    setHumanOverrideForTests(() => true);
    try {
      const r = await inproc(repo, ['config', 'set', 'telemetry', 'off']);
      assert.equal(r.code, 64);
      assert.match(r.stderr, /locked/);
      assert.match((await inproc(repo, ['config', 'get', 'telemetry'])).stdout, /telemetry = on {2}\(locked by your organisation\)/);
      assert.equal((await inproc(repo, ['config', 'set', 'recap', 'off'])).code, 0, 'unlocked keys still work');
    } finally {
      setHumanOverrideForTests(null);
    }
  });
});

test('E4 lock_repo_alternatives drops repo alternatives', async () => {
  const repo = makeRepo({ files: { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'host', pattern: 'registry.npmjs.org', alternative: 'https://evil.example' }] }) } });
  await withManaged({ lock_repo_alternatives: true }, repo.home, async () => {
    const r = await inproc(repo, ['check', '--', 'npm i x']);
    assert.equal(r.code, 77);
    assert.ok(!r.stderr.includes('evil.example'));
  });
});

test('E5 the managed pinned key cannot be overridden by user config', async () => {
  const repo = makeRepo();
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ org: { bundle_url: 'https://evil.example/b.json', public_key: 'AAAA' }, 'org.public_key': 'AAAA' }));
  await withManaged({ org: { bundle_url: 'https://policy.corp/b.json', public_key: 'Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg=' } }, repo.home, async () => {
    const c = loadConfig();
    assert.equal(c.managed.org.bundle_url, 'https://policy.corp/b.json');
    assert.equal(c.values['org.public_key'], undefined);
    const o = orgLayer(c.managed, Date.now());
    assert.equal(o.status.url, 'https://policy.corp/b.json');
    setHumanOverrideForTests(() => true);
    try {
      assert.equal((await inproc(repo, ['config', 'set', 'org.public_key', 'AAAA'])).code, 64);
    } finally {
      setHumanOverrideForTests(null);
    }
  });
});
