// kerb doctor tls [--dry-run]: find the company root CAs a TLS-intercepting proxy uses, export a
// bundle to ~/.kerb/ca-bundle.pem and point tls.ca_bundle at it (KERB-V2 8.3). Writing needs the
// human's typed code. Candidates are CA certificates in the OS trust store that are not among
// the public roots Node ships (tls.rootCertificates).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { KerbError, now } from '../util/core.js';
import { homeKerbDir } from '../util/fsx.js';
import { loadConfig, setUserConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { findRoot } from '../util/repo.js';
import { requireHuman } from '../bound/human.js';
import { caBundleFor } from '../insight/envclass.js';
import { parseOpts } from './args.js';

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Directories where Linux distributions keep locally added (not distribution-shipped) CAs. */
export const LINUX_ANCHOR_DIRS = [
  '/usr/local/share/ca-certificates', // Debian, Ubuntu (update-ca-certificates)
  '/etc/pki/ca-trust/source/anchors', // RHEL, Fedora, CentOS (update-ca-trust)
  '/etc/ca-certificates/trust-source/anchors', // Arch (trust anchor)
  '/usr/share/pki/trust/anchors', // openSUSE
  '/etc/pki/trust/anchors', // SLES
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 20_000 });
  return r.status === 0 ? r.stdout : '';
}

function walkFiles(dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * PEM certificates from the OS trust store, with where they came from.
 * @returns {{ pem: string, source: string }[]}
 */
export function osTrustStore(platform = process.platform) {
  const out = [];
  const add = (text, source) => { for (const pem of String(text).match(PEM_RE) || []) out.push({ pem, source }); };
  if (platform === 'darwin') {
    // Admin- and MDM-installed roots live in the System keychain; Apple's own roots are elsewhere.
    add(run('security', ['find-certificate', '-a', '-p', '/Library/Keychains/System.keychain']), 'macOS System keychain');
    const login = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
    if (fs.existsSync(login)) add(run('security', ['find-certificate', '-a', '-p', login]), 'macOS login keychain');
  } else if (platform === 'win32') {
    const ps = "Get-ChildItem Cert:\\LocalMachine\\Root,Cert:\\CurrentUser\\Root | ForEach-Object { '-----BEGIN CERTIFICATE-----'; [Convert]::ToBase64String($_.RawData,'InsertLineBreaks'); '-----END CERTIFICATE-----' }";
    add(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]), 'Windows Root store');
  } else {
    for (const dir of LINUX_ANCHOR_DIRS) for (const f of walkFiles(dir)) {
      try { add(fs.readFileSync(f, 'utf8'), f); } catch { /* unreadable */ }
    }
  }
  return out;
}

let storeOverride = null;
/** Tests only (in-process): replace the OS trust store reader. */
export function setTrustStoreForTests(fn) { storeOverride = fn; }

/**
 * Company CA candidates: CA certificates, still valid, not among Node's bundled public roots.
 * @param {{ pem: string, source: string }[]} certs
 */
export function candidates(certs, nowTs = Date.now()) {
  const publicRoots = new Set();
  for (const pem of tls.rootCertificates) {
    try { publicRoots.add(new X509Certificate(pem).fingerprint256); } catch { /* skip */ }
  }
  const seen = new Set();
  const out = [];
  for (const { pem, source } of certs) {
    let x;
    try { x = new X509Certificate(pem); } catch { continue; }
    if (!x.ca || publicRoots.has(x.fingerprint256) || seen.has(x.fingerprint256)) continue;
    if (Date.parse(x.validTo) < nowTs) continue;
    seen.add(x.fingerprint256);
    out.push({ subject: x.subject.replace(/\n/g, ', '), valid_to: new Date(Date.parse(x.validTo)).toISOString().slice(0, 10), fingerprint256: x.fingerprint256, source, pem: x.toString().trim() });
  }
  return out;
}

export default async function doctorTls(ctx, args) {
  const { opts } = parseOpts(args, { 'dry-run': 'bool' });
  const config = loadConfig();
  const { root } = findRoot(ctx.cwd);
  const current = caBundleFor(config, loadPolicy(root, config, now()));
  const found = candidates((storeOverride || osTrustStore)());
  const target = path.join(homeKerbDir({ create: false }), 'ca-bundle.pem');
  const report = { configured: current, candidates: found.map(({ pem, ...c }) => c), bundle: target, written: false };
  const say = (s) => { if (!ctx.json) ctx.out(s); };
  say(`kerb doctor tls · ${current ? `tls.ca_bundle is ${current.path} (from ${current.source})` : 'no company CA bundle configured'}\n`);
  if (!found.length) {
    say('  no company root CAs found in the OS trust store (only public roots)\n');
    say('  if a proxy intercepts TLS here, ask IT for the company root CA, save it as PEM, and run: kerb config set tls.ca_bundle <path>\n');
    if (ctx.json) ctx.emitJson(report);
    return 0;
  }
  say(`  ${found.length} candidate company root CA${found.length === 1 ? '' : 's'} (CA certificates in the OS trust store that are not public roots):\n`);
  for (const c of found) say(`    ${c.subject} · valid until ${c.valid_to} · ${c.source}\n`);
  if (current && current.source !== 'your Kerb config') {
    say(`  nothing to write: ${current.source} already sets the bundle\n`);
    if (ctx.json) ctx.emitJson(report);
    return 0;
  }
  if (opts['dry-run']) {
    say(`  dry run: would write ${target} (public roots plus these CAs) and set tls.ca_bundle\n`);
    if (ctx.json) ctx.emitJson(report);
    return 0;
  }
  try {
    requireHuman(`kerb doctor tls (write ${target} and set tls.ca_bundle)`);
  } catch (e) {
    if (!(e instanceof KerbError)) throw e;
    say('  nothing written: run kerb doctor tls in your own terminal to export them\n');
    if (ctx.json) ctx.emitJson({ ...report, error: e.message });
    return e.code;
  }
  // Public roots too: SSL_CERT_FILE, REQUESTS_CA_BUNDLE, AWS_CA_BUNDLE and friends replace the
  // default store instead of adding to it, so a company-only file would break public sites.
  const body = [...tls.rootCertificates.map((p) => p.trim()), ...found.map((c) => `# ${c.subject}\n${c.pem}`)].join('\n');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${body}\n`, { mode: 0o644 });
  setUserConfig('tls.ca_bundle', target);
  report.written = true;
  say(`  wrote ${target} (${tls.rootCertificates.length} public roots + ${found.length} company CA${found.length === 1 ? '' : 's'}) and set tls.ca_bundle\n`);
  if (ctx.json) ctx.emitJson(report);
  return 0;
}
