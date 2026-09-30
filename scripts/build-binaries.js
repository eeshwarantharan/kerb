#!/usr/bin/env node
// Build standalone Kerb binaries with Node's single-executable application (SEA) support.
//
//   node scripts/build-binaries.js [--targets darwin-arm64,linux-x64,…|all] [--node-version v24.21.0] [--out dist/bin]
//
// Steps: bundle src/ into one CommonJS file, generate the SEA blob with a Node of the same
// version as the targets, download each target's official Node binary, inject the blob with
// postject (fetched with npx at build time; not a dependency), ad-hoc sign on macOS, and write
// SHA256SUMS. The code cache is enabled only when the target matches the build machine, since
// V8 code caches don't cross architectures.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };

export const ALL_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win-x64'];
const HOST = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';

const targetsArg = opt('targets', HOST);
const targets = targetsArg === 'all' ? ALL_TARGETS : targetsArg.split(',').map((t) => t.trim()).filter(Boolean);
const nodeVersion = opt('node-version', 'v24.21.0');
const outDir = path.resolve(root, opt('out', 'dist/bin'));
const cacheDir = path.join(root, 'dist', 'node-cache');

function run(cmd, argv, o = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
}

function archiveName(target) {
  const [plat, arch] = target.split('-');
  if (plat === 'win') return `node-${nodeVersion}-win-${arch}.zip`;
  return `node-${nodeVersion}-${plat}-${arch}.tar.${plat === 'linux' ? 'xz' : 'gz'}`;
}

/** Download (once) and extract the official node binary for a target. */
function nodeBinary(target) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = archiveName(target);
  const dest = path.join(cacheDir, `${nodeVersion}-${target}${target.startsWith('win') ? '.exe' : ''}`);
  if (fs.existsSync(dest)) return dest;
  const url = `https://nodejs.org/dist/${nodeVersion}/${archive}`;
  const file = path.join(cacheDir, archive);
  if (!fs.existsSync(file)) run('curl', ['-fsSL', '-o', file, url]);
  verifyNodeArchive(file, archive);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-node-'));
  const inner = target.startsWith('win') ? `${archive.replace(/\.zip$/, '')}/node.exe` : `${archive.replace(/\.tar\.(gz|xz)$/, '')}/bin/node`;
  run('tar', ['-xf', file, '-C', tmp, inner]);
  fs.copyFileSync(path.join(tmp, inner), dest);
  fs.chmodSync(dest, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
  return dest;
}

/** Check the archive against nodejs.org's SHASUMS256.txt. */
function verifyNodeArchive(file, archive) {
  const sums = path.join(cacheDir, `SHASUMS256-${nodeVersion}.txt`);
  if (!fs.existsSync(sums)) run('curl', ['-fsSL', '-o', sums, `https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`]);
  const line = fs.readFileSync(sums, 'utf8').split('\n').find((l) => l.endsWith(`  ${archive}`));
  if (!line) throw new Error(`no checksum for ${archive}`);
  const want = line.split(/\s+/)[0];
  const got = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${archive}`);
}

function sha256File(f) {
  return createHash('sha256').update(fs.readFileSync(f)).digest('hex');
}

async function main() {
  for (const t of targets) if (!ALL_TARGETS.includes(t)) throw new Error(`unknown target ${t}; known: ${ALL_TARGETS.join(', ')}`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-sea-'));
  const bundlePath = path.join(work, 'kerb.cjs');
  execFileSync(process.execPath, [path.join(root, 'scripts', 'bundle.js'), '--out', bundlePath], { stdio: 'inherit' });
  // The blob must come from a Node of the same version as the targets.
  const hostNode = nodeBinary(HOST);
  const blobs = {};
  for (const withCache of [false, true]) {
    if (withCache && !targets.includes(HOST)) continue;
    const blob = path.join(work, `sea-${withCache ? 'cache' : 'plain'}.blob`);
    const config = path.join(work, `sea-${withCache ? 'cache' : 'plain'}.json`);
    fs.writeFileSync(config, JSON.stringify({ main: bundlePath, output: blob, disableExperimentalSEAWarning: true, useCodeCache: withCache, useSnapshot: false }));
    run(hostNode, ['--experimental-sea-config', config]);
    blobs[withCache ? 'cache' : 'plain'] = blob;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const sums = [];
  for (const target of targets) {
    const exe = target.startsWith('win') ? '.exe' : '';
    const out = path.join(outDir, `kerb-${target}${exe}`);
    fs.copyFileSync(nodeBinary(target), out);
    fs.chmodSync(out, 0o755);
    const isMac = target.startsWith('darwin');
    if (isMac && process.platform === 'darwin') run('codesign', ['--remove-signature', out]);
    const blob = target === HOST && blobs.cache ? blobs.cache : blobs.plain;
    const pj = ['--yes', POSTJECT, out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE];
    if (isMac) pj.push('--macho-segment-name', 'NODE_SEA');
    run(process.platform === 'win32' ? 'npx.cmd' : 'npx', pj);
    if (isMac && process.platform === 'darwin') run('codesign', ['--sign', '-', out]);
    sums.push(`${sha256File(out)}  ${path.basename(out)}`);
    console.log(`built ${path.relative(root, out)}`);
  }
  fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`wrote ${path.relative(root, path.join(outDir, 'SHA256SUMS'))}`);
}

main().catch((e) => {
  console.error(`build-binaries: ${e.message}`);
  process.exit(1);
});
