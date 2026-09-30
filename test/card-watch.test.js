import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, runKerbAsync, waitFor, tmpDir } from './helpers.js';
import { Store } from '../src/store/jsonl.js';

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) };

/** Minimal XML well-formedness check: balanced tags, quoted attributes, known entities. */
function assertWellFormedXml(xml) {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, '');
  const stack = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<!--[\s\S]*?-->|&(?!(?:amp|lt|gt|quot|apos|#\d+);)/g;
  let m;
  let last = 0;
  while ((m = re.exec(body))) {
    const between = body.slice(last, m.index);
    assert.ok(!between.includes('<'), `stray < near ${JSON.stringify(between.slice(0, 40))}`);
    last = re.lastIndex;
    if (m[0].startsWith('&')) assert.fail(`unescaped & at ${m.index}`);
    if (m[0].startsWith('<!--')) continue;
    if (m[4]) continue;
    if (m[1]) assert.equal(stack.pop(), m[2], `closing ${m[2]}`);
    else stack.push(m[2]);
  }
  assert.ok(!body.slice(last).includes('<'));
  assert.deepEqual(stack, []);
}

function withSaves() {
  const repo = makeRepo({ files: POLICY });
  repo.kerb(['run', '--', 'docker ps']);
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
  repo.kerb(['run', '--budget', '500', '--', 'seq 1 2000']);
  return repo;
}

// A PATH with node's directory only, so neither rsvg-convert nor qlmanage is found.
const bareEnv = { PATH: path.dirname(process.execPath) };

test('V10 card --week writes a valid SVG and an HTML page', () => {
  const repo = withSaves();
  const out = tmpDir();
  const r = repo.kerb(['card', '--week', '--out', out], { env: bareEnv });
  assert.equal(r.code, 0, r.stderr);
  const svg = fs.readFileSync(path.join(out, 'kerb-card.svg'), 'utf8');
  assertWellFormedXml(svg);
  assert.match(svg, /width="1200" height="628"/);
  assert.match(svg, />1<\/text>\s*<text[^>]*>re-runs avoided</);
  const html = fs.readFileSync(path.join(out, 'kerb-card.html'), 'utf8');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<svg /);
  assert.match(svg, new RegExp(path.basename(repo.dir)));
});

test('V11 --anonymous omits the repo name', () => {
  const repo = withSaves();
  const out = tmpDir();
  repo.kerb(['card', '--session', '--anonymous', '--out', out], { env: bareEnv });
  const svg = fs.readFileSync(path.join(out, 'kerb-card.svg'), 'utf8');
  assert.ok(!svg.includes(path.basename(repo.dir)));
  assert.match(svg, /this session/);
});

test('V12 no dollar figure unless prices are set; when shown it says "est."', () => {
  const repo = withSaves();
  const a = tmpDir();
  repo.kerb(['card', '--out', a], { env: bareEnv });
  assert.ok(!fs.readFileSync(path.join(a, 'kerb-card.svg'), 'utf8').includes('$'));
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ 'price.input_per_mtok': 3 }));
  const b = tmpDir();
  repo.kerb(['card', '--out', b], { env: bareEnv });
  const svg = fs.readFileSync(path.join(b, 'kerb-card.svg'), 'utf8');
  assert.match(svg, /≈ \$[\d.]+ est\. input cost avoided/);
});

test('V13 a PNG is written when a converter exists; otherwise the screenshot hint', () => {
  const repo = withSaves();
  const none = tmpDir();
  const r = repo.kerb(['card', '--out', none], { env: bareEnv });
  assert.match(r.stdout, /open kerb-card\.html and take a screenshot/);
  assert.equal(fs.existsSync(path.join(none, 'kerb-card.png')), false);
  const bin = tmpDir();
  fs.writeFileSync(path.join(bin, 'rsvg-convert'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then printf PNG > "$2"; fi; shift; done\n');
  fs.chmodSync(path.join(bin, 'rsvg-convert'), 0o755);
  const withConv = tmpDir();
  const r2 = repo.kerb(['card', '--out', withConv], { env: { PATH: `${bin}:${path.dirname(process.execPath)}` } });
  assert.ok(fs.existsSync(path.join(withConv, 'kerb-card.png')), r2.stdout);
  assert.ok(!r2.stdout.includes('screenshot'));
});

test('V14 watch prints new events within 1 s; V15 it survives rotation', async () => {
  const repo = makeRepo();
  const store = new Store(repo.dir, { rotateBytes: 600 });
  store.append([{ type: 'end', id: 'old', ts: Date.now(), key: 'k::old', class: 'other', exit: 0, class_result: 'ok' }]);
  const w = runKerbAsync(['watch'], { cwd: repo.dir, env: repo.env });
  let out = '';
  w.child.stdout.on('data', (d) => { out += d; });
  try {
    await waitFor(() => out.includes('kerb watch'), 5000);
    const t0 = Date.now();
    store.append([{ type: 'refusal', id: 'r1', ts: Date.now(), key: 'k::npm test', reason: 'identical_retry', summary: 'nothing changed' }]);
    assert.ok(await waitFor(() => out.includes('kerb: identical_retry'), 3000), out);
    assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
    assert.ok(!out.includes('k::old'), 'starts at the end of the file');
    for (let i = 0; i < 8; i++) store.append([{ type: 'end', id: `e${i}`, ts: Date.now(), key: `k::cmd-${i}`, class: 'other', exit: 0, class_result: 'ok', pad: 'x'.repeat(80) }]);
    assert.ok(store.rotatedFiles().length >= 1, 'rotated');
    assert.ok(await waitFor(() => out.includes('k::cmd-7'), 3000), out);
    for (let i = 0; i < 8; i++) assert.ok(out.includes(`k::cmd-${i}`), `event ${i}`);
  } finally {
    w.child.kill('SIGINT');
    await w.done;
  }
});
