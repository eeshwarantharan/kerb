import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, tmpDir } from './helpers.js';
import { transform } from '../scripts/bundle.js';

const binDir = path.join(ROOT, 'dist', 'bin');
const built = fs.existsSync(path.join(binDir, 'SHA256SUMS'));

test('Z8 SHA256SUMS matches every built binary; the release attests provenance', { skip: !built && 'no binaries built (node scripts/build-binaries.js)' }, () => {
  const lines = fs.readFileSync(path.join(binDir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  assert.ok(lines.length >= 1);
  for (const l of lines) {
    const [sum, name] = l.split(/\s+/);
    const got = createHash('sha256').update(fs.readFileSync(path.join(binDir, name))).digest('hex');
    assert.equal(got, sum, name);
  }
});

test('the release workflow publishes checksums, attestations, SBOM, npm provenance and the tap', () => {
  const wf = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
  for (const s of ['sha256sum kerb-*', 'actions/attest-build-provenance', 'scripts/sbom.js', 'npm publish --provenance', 'scripts/homebrew.js']) assert.ok(wf.includes(s), s);
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  for (const s of ['ubuntu-latest', 'macos-latest', 'windows-latest', 'shuffle-tests.js --runs 10', 'KERB_TEST_PERF', 'npm pack', 'dependencies']) assert.ok(ci.includes(s), s);
});

test('Z9 the Homebrew formula names every platform binary with its checksum', () => {
  const dir = tmpDir();
  const sums = path.join(dir, 'SHA256SUMS');
  const names = ['kerb-darwin-arm64', 'kerb-darwin-x64', 'kerb-linux-arm64', 'kerb-linux-x64', 'kerb-win-x64.exe'];
  fs.writeFileSync(sums, names.map((n, i) => `${String(i).repeat(64)}  ${n}`).join('\n'));
  const out = path.join(dir, 'kerb.rb');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/homebrew.js'), '--version', '1.2.3', '--sums', sums, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const rb = fs.readFileSync(out, 'utf8');
  for (const [i, n] of names.slice(0, 4).entries()) {
    assert.ok(rb.includes(`releases/download/v1.2.3/${n}"`), n);
    assert.ok(rb.includes(`sha256 "${String(i).repeat(64)}"`), n);
  }
  assert.match(rb, /system bin\/"kerb", "doctor"/);
  const ruby = spawnSync('ruby', ['-c', out], { encoding: 'utf8' });
  if (!ruby.error) assert.equal(ruby.status, 0, ruby.stderr);
});

test('the SBOM is CycloneDX 1.5 with no dependencies', () => {
  const out = path.join(tmpDir(), 'sbom.json');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/sbom.js'), '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(s.bomFormat, 'CycloneDX');
  assert.equal(s.specVersion, '1.5');
  assert.equal(s.metadata.component.name, 'kerb-cli');
  assert.deepEqual(s.dependencies[0].dependsOn, []);
});

test('the bundler rejects syntax it does not handle, instead of producing a broken bundle', () => {
  assert.throws(() => transform("import x from './a.js';\n", path.join(ROOT, 'src/x.js')), /default import/);
  assert.throws(() => transform('const m = await import(name);\n', path.join(ROOT, 'src/x.js')), /computed specifier/);
  const t = transform("import { a as b } from './y.js';\nexport function f() { return b; }\nexport default async function g() {}\n", path.join(ROOT, 'src/x.js'));
  assert.match(t.body, /const \{ a: b \} = __kerbReq\("src\/y\.js"\);/);
  assert.match(t.body, /^exports\.f = f;$/m);
  assert.match(t.body, /^exports\.default = g;$/m);
});

test('npm pack ships the CLI and nothing from test/ or dist/', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' });
  if (r.error) return;
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path);
  assert.ok(files.includes('bin/kerb.js'));
  assert.ok(files.includes('src/cli/main.js'));
  assert.ok(files.includes('LICENSE'));
  assert.ok(!files.some((f) => f.startsWith('test/') || f.startsWith('dist/') || f.startsWith('bench/')));
});
