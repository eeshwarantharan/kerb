// Org bundle (4.8.4): fetch with ETag, verify Ed25519 against the key pinned by the managed
// config, cache in ~/.kerb/org/, and platform-team tools (keygen, sign, verify).
// This file and telemetry/otlp.js are the only code paths that touch the network.
import fs from 'node:fs';
import path from 'node:path';
import { createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { UsageError, now } from '../util/core.js';
import { atomicWrite, ensureDir, homeKerbDir, readJson } from '../util/fsx.js';
import { lintPolicy } from './policy.js';
import { parseOpts } from '../cli/args.js';

const FETCH_TIMEOUT_MS = 2000;
const REFRESH_EVERY_MS = 15 * 60_000;

function orgDir() { return ensureDir(path.join(homeKerbDir(), 'org')); }
function bundleFile() { return path.join(orgDir(), 'bundle.json'); }
function metaFile() { return path.join(orgDir(), 'meta.json'); }

/** Public key from base64 (raw 32 bytes) or a PEM. */
export function publicKeyFrom(value) {
  const v = String(value || '').trim();
  if (v.includes('BEGIN PUBLIC KEY')) return createPublicKey(v);
  const raw = Buffer.from(v, 'base64');
  if (raw.length !== 32) throw new Error('org.public_key must be a base64 Ed25519 public key (32 bytes)');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' });
}

/**
 * Verify a bundle's signature; returns the decoded payload or throws.
 * @param {string} text bundle JSON
 * @param {string} publicKey base64 or PEM
 */
export function verifyBundle(text, publicKey) {
  const b = JSON.parse(text);
  if (!b || typeof b.payload !== 'string' || typeof b.signature !== 'string') throw new Error('not a Kerb policy bundle');
  const payload = Buffer.from(b.payload, 'base64');
  const ok = verify(null, payload, publicKeyFrom(publicKey), Buffer.from(b.signature, 'base64'));
  if (!ok) throw new Error('bundle signature does not verify against the pinned key');
  const inner = JSON.parse(payload.toString('utf8'));
  if (!inner || typeof inner.policy !== 'object') throw new Error('bundle has no policy');
  return inner;
}

/** Sign a policy object into a bundle. */
export function signBundle(policy, privateKeyPem, bundleVersion, signedAt = new Date().toISOString()) {
  const payload = Buffer.from(JSON.stringify({ bundle_version: bundleVersion, signed_at: signedAt, policy }), 'utf8');
  const signature = sign(null, payload, createPrivateKey(privateKeyPem));
  return { format: 'kerb-bundle', version: 1, bundle_version: bundleVersion, signed_at: signedAt, payload: payload.toString('base64'), signature: signature.toString('base64') };
}

function orgSettings(managed) {
  const org = managed && managed.org;
  if (!org || !org.bundle_url || !org.public_key) return null;
  return { url: String(org.bundle_url), key: String(org.public_key), maxCacheMs: (Number(org.max_cache_hours) || 24) * 3_600_000 };
}

/**
 * The org layer from the cached, verified bundle (sync; never touches the network).
 * @returns {{ layer: any, status: any } | null}
 */
export function orgLayer(managed, nowTs = now()) {
  const s = orgSettings(managed);
  if (!s) return null;
  const meta = readJson(metaFile(), {}) || {};
  let text = null;
  try { text = fs.readFileSync(bundleFile(), 'utf8'); } catch { /* no cache yet */ }
  const status = {
    url: s.url,
    version: null,
    fetched_at: meta.fetched_at || null,
    stale: false,
    offline: !!meta.last_error,
    last_error: meta.last_error || null,
    cached: !!text,
  };
  if (!text || meta.url !== s.url) return { layer: null, status: { ...status, cached: false } };
  let inner;
  try {
    inner = verifyBundle(text, s.key);
  } catch (e) {
    return { layer: null, status: { ...status, last_error: `cached bundle rejected: ${e.message}` } };
  }
  status.version = inner.bundle_version ?? null;
  // An expired cache is still used (never silently "no rules"); the status line warns.
  status.stale = !meta.fetched_at || nowTs - meta.fetched_at > s.maxCacheMs;
  return {
    layer: { name: 'org', version: status.version, source: `org policy v${status.version ?? '?'}`, policy: inner.policy, stale: status.stale },
    status,
  };
}

/**
 * Fetch the bundle if configured and due (or forced). Only verified bundles replace the cache.
 * @param {any} managed
 * @param {{ force?: boolean, fetchImpl?: typeof fetch, timeoutMs?: number }} [o]
 */
export async function refreshOrg(managed, o = {}) {
  const s = orgSettings(managed);
  if (!s) return { skipped: 'not configured' };
  const meta = readJson(metaFile(), {}) || {};
  const t = now();
  if (!o.force && meta.last_attempt && t - meta.last_attempt < REFRESH_EVERY_MS && meta.url === s.url) return { skipped: 'recent' };
  meta.last_attempt = t;
  const headers = { accept: 'application/json' };
  if (meta.etag && meta.url === s.url) headers['if-none-match'] = meta.etag;
  const doFetch = o.fetchImpl || globalThis.fetch;
  try {
    const res = await doFetch(s.url, { headers, signal: AbortSignal.timeout(o.timeoutMs || FETCH_TIMEOUT_MS) });
    if (res.status === 304) {
      meta.fetched_at = t;
      meta.last_error = null;
      atomicWrite(metaFile(), JSON.stringify(meta));
      return { notModified: true };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const inner = verifyBundle(text, s.key);
    atomicWrite(bundleFile(), text);
    Object.assign(meta, { url: s.url, etag: res.headers.get('etag') || null, fetched_at: t, last_error: null, version: inner.bundle_version ?? null });
    atomicWrite(metaFile(), JSON.stringify(meta));
    return { updated: true, version: inner.bundle_version };
  } catch (e) {
    meta.last_error = e && e.name === 'TimeoutError' ? 'fetch timed out after 2 s' : String(e && e.message ? e.message : e);
    atomicWrite(metaFile(), JSON.stringify(meta));
    return { error: meta.last_error };
  }
}

// ---------------------------------------------------------------------------
// kerb policy keygen | sign | verify

export async function policyCommand(ctx, sub, args) {
  if (sub === 'keygen') {
    const { opts } = parseOpts(args, { out: 'string' });
    const dir = path.resolve(ctx.cwd, opts.out || '.');
    fs.mkdirSync(dir, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
    const privPath = path.join(dir, 'kerb-org.key');
    const pubPath = path.join(dir, 'kerb-org.pub');
    if (fs.existsSync(privPath)) throw new UsageError(`${privPath} already exists; refusing to overwrite a signing key`);
    fs.writeFileSync(privPath, priv, { mode: 0o600 });
    fs.writeFileSync(pubPath, `${pub}\n`);
    if (ctx.json) ctx.emitJson({ private_key: privPath, public_key: pub, public_key_file: pubPath });
    else ctx.out(`kerb policy keygen · wrote ${privPath} (keep secret) and ${pubPath}\n  pin this in the managed config as org.public_key: ${pub}\n`);
    return 0;
  }
  if (sub === 'sign') {
    const { opts, positionals } = parseOpts(args, { key: 'string', out: 'string', 'bundle-version': 'string' });
    if (positionals.length !== 1 || !opts.key) throw new UsageError('usage: kerb policy sign <policy.json> --key <private.key> [--bundle-version N] [--out bundle.json]');
    const policyPath = path.resolve(ctx.cwd, positionals[0]);
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const errors = lintPolicy(policy).filter((p) => p.level === 'error');
    if (errors.length) throw new UsageError(`policy has errors; run kerb policy lint: ${errors.map((e) => e.message).join('; ')}`);
    const version = opts['bundle-version'] ? Number(opts['bundle-version']) : Number(new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12));
    if (!Number.isInteger(version) || version < 0) throw new UsageError('--bundle-version must be a whole number');
    const bundle = signBundle(policy, fs.readFileSync(path.resolve(ctx.cwd, opts.key), 'utf8'), version);
    const out = path.resolve(ctx.cwd, opts.out || 'kerb-bundle.json');
    fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`);
    if (ctx.json) ctx.emitJson({ bundle: out, bundle_version: version });
    else ctx.out(`kerb policy sign · wrote ${out} (bundle v${version})\n`);
    return 0;
  }
  // verify
  const { opts, positionals } = parseOpts(args, { pub: 'string' });
  if (positionals.length !== 1 || !opts.pub) throw new UsageError('usage: kerb policy verify <bundle.json> --pub <base64 key or file>');
  let pub = opts.pub;
  const pubPath = path.resolve(ctx.cwd, pub);
  if (fs.existsSync(pubPath)) pub = fs.readFileSync(pubPath, 'utf8');
  try {
    const inner = verifyBundle(fs.readFileSync(path.resolve(ctx.cwd, positionals[0]), 'utf8'), pub);
    const errors = lintPolicy(inner.policy).filter((p) => p.level === 'error');
    if (ctx.json) ctx.emitJson({ ok: errors.length === 0, bundle_version: inner.bundle_version, signed_at: inner.signed_at, problems: errors });
    else ctx.out(`kerb policy verify · signature ok · bundle v${inner.bundle_version} signed ${inner.signed_at}${errors.length ? ` · ${errors.length} policy errors` : ''}\n`);
    return errors.length ? 1 : 0;
  } catch (e) {
    if (ctx.json) ctx.emitJson({ ok: false, error: e.message });
    else ctx.err(`kerb policy verify · ${e.message}\n`);
    return 1;
  }
}
