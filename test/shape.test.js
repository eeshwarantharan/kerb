import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Shaper, shapeText } from '../src/run/shape.js';
import { StreamRedactor, redactText } from '../src/run/redact.js';
import { tmpDir } from './helpers.js';

test('B1 ANSI and OSC sequences are removed', () => {
  const r = shapeText('\x1b[31mred\x1b[0m \x1b]0;title\x07plain \x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\\n');
  assert.equal(r.text, 'red plain link\n');
});

test('B2 carriage-return progress keeps the last state', () => {
  assert.equal(shapeText('50%\r75%\r100%\n').text, '100%\n');
  assert.equal(shapeText('a\r\nb\r\n').text, 'a\nb\n');
});

test('B3 10 identical lines fold; 2 identical lines stay', () => {
  const ten = shapeText(`${'same\n'.repeat(10)}end\n`);
  assert.equal(ten.text, 'same\n[kerb] previous line repeated 9 more times\nend\n');
  assert.equal(shapeText('x\nx\ny\n').text, 'x\nx\ny\n');
});

test('B4 over budget → head and tail at line boundaries', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`);
  const r = shapeText(`${lines.join('\n')}\n`, { budget: 1000, logPath: null });
  assert.ok(r.cut);
  assert.ok(r.shownBytes <= 1000 + 100, `shown ${r.shownBytes}`);
  const out = r.text.split('\n').filter(Boolean);
  assert.equal(out[0], 'line 0');
  assert.equal(out.at(-1), 'line 1999');
  assert.match(r.text, /\[kerb\] \d+ lines omitted/);
  for (const l of out) assert.ok(/^line \d+$/.test(l) || l.startsWith('[kerb]'), `whole line: ${l}`);
});

test('B5 a multi-byte character at the cut stays whole', () => {
  const long = 'é'.repeat(5000);
  const r = shapeText(`${long}\n`, { budget: 1001 });
  assert.equal(Buffer.from(r.text, 'utf8').toString('utf8'), r.text);
  assert.ok(!r.text.includes('�'));
  assert.ok(r.cut);
});

test('B6 NUL in the first 8 KB → binary marker only', () => {
  const s = new Shaper({ logPath: null });
  s.push(Buffer.from('hello\n'));
  s.push(Buffer.from([0, 1, 2, 3]));
  s.push(Buffer.from('more\n'));
  const r = s.end();
  assert.equal(r.binary, true);
  assert.match(r.text, /^\[kerb\] binary output, \d+ bytes/);
});

test('B7 large output: memory stays bounded', { timeout: 300_000 }, () => {
  const total = Number(process.env.KERB_TEST_BIG_MB || 256) * 1024 * 1024;
  const chunk = Buffer.from(`${'progress line with some text 0123456789 abcdefghij\n'.repeat(1300)}`);
  global.gc?.();
  const base = process.memoryUsage();
  const s = new Shaper({ logPath: null });
  let peak = 0;
  let pushed = 0;
  let i = 0;
  const t0 = Date.now();
  while (pushed < total) {
    s.push(chunk);
    pushed += chunk.length;
    if (++i % 200 === 0) {
      const m = process.memoryUsage();
      peak = Math.max(peak, m.heapUsed + m.external + m.arrayBuffers - (base.heapUsed + base.external + base.arrayBuffers));
    }
  }
  const r = s.end();
  const secs = (Date.now() - t0) / 1000;
  assert.ok(r.shownBytes <= 12_000 + 200);
  assert.ok(peak < 12_000 + 64 * 1024 + 30 * 1024 * 1024, `peak ${peak}`);
  // Z2 shaping throughput at least 50 MB/s.
  const mbps = pushed / 1024 / 1024 / secs;
  assert.ok(mbps >= 50, `throughput ${mbps.toFixed(1)} MB/s`);
});

test('B10 the raw log equals the redacted child output byte for byte', () => {
  const dir = tmpDir();
  const log = path.join(dir, 'x.log');
  const raw = Buffer.concat([
    Buffer.from('start \x1b[32mgreen\x1b[0m token=abc123secret\n'),
    Buffer.from([0xe9, 0xff, 0x0a]), // invalid UTF-8 survives byte-for-byte
    Buffer.from('progress 1\rprogress 2\n'),
  ]);
  const s = new Shaper({ logPath: log });
  for (let i = 0; i < raw.length; i += 7) s.push(raw.subarray(i, i + 7));
  s.end();
  const expected = Buffer.from(redactText(raw.toString('latin1')), 'latin1');
  assert.deepEqual(fs.readFileSync(log), expected);
  assert.ok(!fs.readFileSync(log, 'latin1').includes('abc123secret'));
});

test('R1 every pattern is redacted', () => {
  const secrets = [
    'AKIAABCDEFGHIJKLMNOP',
    'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    `ghp_${'a'.repeat(36)}`,
    `github_pat_${'b'.repeat(60)}`,
    'xoxb-1234-5678-abcdef',
    `sk-ant-${'c'.repeat(30)}`,
    `sk-${'d'.repeat(40)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sflKxwRJSMeKKF2QT4fwpM',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----',
    'Authorization: Bearer abcdef123456.xyz',
    'https://user:hunter2@example.com/repo',
    'password=hunter2', 'PASSWD: hunter3', 'secret=s3', 'GITHUB_TOKEN=tok123', 'api_key: k1', 'apiKey=k2',
  ];
  for (const s of secrets) {
    const out = redactText(`before ${s} after`);
    assert.match(out, /\[REDACTED\]/, s);
    for (const bit of ['ABCDEFGHIJKLMNOP', 'wJalrXU', 'aaaaaaaa', 'bbbbbbbb', '1234-5678', 'cccccc', 'dddddd', 'sflKxw', 'MIIEow', 'abcdef123456', 'hunter2', 'hunter3', 's3 ', 'tok123', 'k1', 'k2']) {
      if (s.includes(bit)) assert.ok(!out.includes(bit), `${bit} leaked from ${s}: ${out}`);
    }
  }
});

test('R2 a token split across two chunks is redacted', () => {
  const token = `ghp_${'Z'.repeat(40)}`;
  const text = `${'x'.repeat(1000)} ${token} ${'y'.repeat(1000)}`;
  for (const at of [1005, 1010, 1020, 1030]) {
    const r = new StreamRedactor();
    const out = r.push(text.slice(0, at)) + r.push(text.slice(at)) + r.end();
    assert.ok(!out.includes('ZZZZZZZZ'), `split at ${at}`);
    assert.match(out, /\[REDACTED\]/);
  }
  // A private key block spread over many chunks.
  const key = '-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\n-----END PRIVATE KEY-----\nafter\n';
  const r = new StreamRedactor();
  let out = '';
  for (const ch of key) out += r.push(ch);
  out += r.end();
  assert.equal(out, '[REDACTED]\nafter\n');
});

test('R4 ordinary text containing "token" without a value is unchanged', () => {
  for (const s of ['the token was rejected', 'tokenizer: ok', 'missing secret in config', 'password reset flow']) {
    assert.equal(redactText(s), s);
  }
});
