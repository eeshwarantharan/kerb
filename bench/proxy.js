#!/usr/bin/env node
// A restrictive egress proxy for the benchmark: allows CONNECT/HTTP only to allowlisted hosts and
// answers everything else with 403 "blocked by policy: <host>", like a corporate egress proxy.
// With --intercept, it also does what a TLS-inspecting corporate proxy does to those hosts: it
// terminates TLS with a certificate signed by its own CA (made with openssl in --ca-dir; the
// CA is <ca-dir>/ca.pem) and answers every request with {"ok":true,"host":…}.
//   node bench/proxy.js [--port 8899] [--allow localhost,127.0.0.1,api.anthropic.com]
//                       [--intercept '*.corp.test'] [--ca-dir bench/results/tmp/ca]
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const port = Number(opt('port', 8899));
const allow = new Set(opt('allow', 'localhost,127.0.0.1,api.anthropic.com,statsig.anthropic.com').split(','));
const matches = (set) => (host) => set.has(host) || [...set].some((a) => a.startsWith('*.') && host.endsWith(a.slice(1)));
const allowed = matches(allow);
const interceptSet = new Set((opt('intercept', '') || '').split(',').filter(Boolean));
const intercepted = matches(interceptSet);
const caDir = path.resolve(opt('ca-dir', 'bench/results/tmp/ca'));

/** The proxy's CA (created once) and a leaf certificate per host, signed by it. */
export function ensureCa(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'ca.key');
  const pem = path.join(dir, 'ca.pem');
  if (!fs.existsSync(pem)) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', pem, '-days', '30', '-subj', '/CN=Bench Corp Inspection CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], { stdio: 'ignore' });
  }
  return { key, pem };
}
const contexts = new Map();
function contextFor(host) {
  if (contexts.has(host)) return contexts.get(host);
  const ca = ensureCa(caDir);
  const base = path.join(caDir, host.replace(/[^\w.-]/g, '_'));
  if (!fs.existsSync(`${base}.pem`)) {
    execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${base}.key`, '-out', `${base}.csr`, '-subj', `/CN=${host}`], { stdio: 'ignore' });
    fs.writeFileSync(`${base}.ext`, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
    execFileSync('openssl', ['x509', '-req', '-in', `${base}.csr`, '-CA', ca.pem, '-CAkey', ca.key, '-CAcreateserial', '-out', `${base}.pem`, '-days', '30', '-extfile', `${base}.ext`], { stdio: 'ignore' });
  }
  const ctx = tls.createSecureContext({ key: fs.readFileSync(`${base}.key`), cert: fs.readFileSync(`${base}.pem`) });
  contexts.set(host, ctx);
  return ctx;
}
const inspected = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(`${JSON.stringify({ ok: true, host: req.headers.host || null, path: req.url })}\n`);
});

const server = http.createServer((req, res) => {
  let host;
  try { host = new URL(req.url).hostname; } catch { res.writeHead(400).end(); return; }
  if (!allowed(host)) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end(`blocked by policy: ${host}\n`);
    return;
  }
  const up = http.request(req.url, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  up.on('error', () => res.writeHead(502).end());
  req.pipe(up);
});
server.on('connect', (req, sock, head) => {
  const [host, p] = req.url.split(':');
  if (intercepted(host)) {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const t = new tls.TLSSocket(sock, { isServer: true, secureContext: contextFor(host) });
    if (head && head.length) t.unshift(head);
    t.on('error', () => sock.destroy());
    inspected.emit('connection', t);
    return;
  }
  if (!allowed(host)) {
    sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nblocked by policy: ${host}\n`);
    return;
  }
  const up = net.connect(Number(p) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.end());
  sock.on('error', () => up.destroy());
});
if (interceptSet.size) ensureCa(caDir);
server.listen(port, '127.0.0.1', () => console.log(`egress proxy on http://127.0.0.1:${port}, allowing ${[...allow].join(', ')}${interceptSet.size ? `, intercepting ${[...interceptSet].join(', ')} (CA ${path.join(caDir, 'ca.pem')})` : ''}`));
