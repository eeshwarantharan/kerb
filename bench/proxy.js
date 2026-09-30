#!/usr/bin/env node
// A restrictive egress proxy for the benchmark: allows CONNECT/HTTP only to allowlisted hosts and
// answers everything else with 403 "blocked by policy: <host>", like a corporate egress proxy.
//   node bench/proxy.js [--port 8899] [--allow localhost,127.0.0.1,api.anthropic.com]
import http from 'node:http';
import net from 'node:net';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const port = Number(opt('port', 8899));
const allow = new Set(opt('allow', 'localhost,127.0.0.1,api.anthropic.com,statsig.anthropic.com').split(','));
const allowed = (host) => allow.has(host) || [...allow].some((a) => a.startsWith('*.') && host.endsWith(a.slice(1)));

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
  if (!allowed(host)) {
    sock.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nblocked by policy: ${host}\n`);
    return;
  }
  const up = net.connect(Number(p) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
  up.on('error', () => sock.end());
  sock.on('error', () => up.destroy());
});
server.listen(port, '127.0.0.1', () => console.log(`egress proxy on http://127.0.0.1:${port}, allowing ${[...allow].join(', ')}`));
