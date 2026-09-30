import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Store, crc32, decodeRecord, encodeRecord, buildRuns } from '../src/store/jsonl.js';
import { EXIT, KerbError } from '../src/util/core.js';
import { ROOT, tmpDir } from './helpers.js';

test('crc32 matches the IEEE reference value', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
});

test('records round-trip with a crc', () => {
  const line = encodeRecord({ type: 'start', id: 'x', n: 1 });
  assert.match(line, /"crc":\d+\}$/);
  assert.deepEqual(decodeRecord(line), { type: 'start', id: 'x', n: 1 });
  assert.equal(decodeRecord(line.replace('"n":1', '"n":2')), null);
});

test('S2 a truncated last line is repaired', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.append([{ type: 'start', id: 'a', ts: 1 }, { type: 'end', id: 'a', ts: 2 }]);
  const good = fs.readFileSync(s.file, 'utf8');
  fs.appendFileSync(s.file, encodeRecord({ type: 'start', id: 'b', ts: 3 }).slice(0, 20));
  const recs = s.read();
  assert.equal(recs.length, 2);
  assert.equal(fs.readFileSync(s.file, 'utf8'), good);
});

test('S3 a corrupt middle line → exit 71, file byte-identical afterwards', () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.append([{ type: 'start', id: 'a', ts: 1 }, { type: 'end', id: 'a', ts: 2 }, { type: 'start', id: 'b', ts: 3 }]);
  const lines = fs.readFileSync(s.file, 'utf8').split('\n');
  lines[1] = lines[1].replace('"ts":2', '"ts":9');
  fs.writeFileSync(s.file, lines.join('\n'));
  const before = fs.readFileSync(s.file);
  assert.throws(() => s.read(), (e) => e instanceof KerbError && e.code === EXIT.CORRUPT && /line 2/.test(e.message));
  assert.deepEqual(fs.readFileSync(s.file), before);
});

test('S4 a stale lock with a dead PID is broken', () => {
  const dir = tmpDir();
  const s = new Store(dir).ensure();
  fs.writeFileSync(s.lockPath, '999999 0');
  const t0 = Date.now();
  s.append([{ type: 'start', id: 'a', ts: 1 }]);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(fs.existsSync(s.lockPath), false);
  assert.equal(s.read().length, 1);
});

test('S4 a lock older than 30 s is broken even if the PID is alive', () => {
  const dir = tmpDir();
  const s = new Store(dir).ensure();
  fs.writeFileSync(s.lockPath, `${process.pid} 0`);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(s.lockPath, old, old);
  s.append([{ type: 'start', id: 'a', ts: 1 }]);
  assert.equal(s.read().length, 1);
});

test('S5 rotation at the size limit; readers see both files', () => {
  const dir = tmpDir();
  const s = new Store(dir, { rotateBytes: 400 });
  for (let i = 0; i < 12; i++) s.append([{ type: 'start', id: `r${i}`, ts: i, pad: 'x'.repeat(40) }]);
  const rotated = s.rotatedFiles();
  assert.ok(rotated.length >= 1, 'rotated at least once');
  const recs = s.read();
  const ids = recs.map((r) => r.id);
  // Readers see the current file plus the previous one, in order.
  assert.ok(ids.length > fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).length);
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
  assert.equal(ids.at(-1), 'r11');
});

test('S6 summary.json is never observed half-written', async () => {
  const dir = tmpDir();
  new Store(dir).ensure();
  const script = `
    import { Store } from ${JSON.stringify(path.join(ROOT, 'src/store/jsonl.js'))};
    const s = new Store(${JSON.stringify(dir)});
    for (let i = 0; i < 60; i++) s.append([{ type: 'end', id: 'x' + i, ts: Date.now(), raw_bytes: 10, shown_bytes: 5 }]);
  `;
  const writers = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'inherit' }));
  const done = Promise.all(writers.map((w) => new Promise((r) => w.on('exit', r))));
  let finished = false;
  done.then(() => { finished = true; });
  let reads = 0;
  const file = path.join(dir, '.kerb', 'summary.json');
  while (!finished) {
    if (fs.existsSync(file)) {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      reads++;
    }
    await new Promise((r) => setImmediate(r));
  }
  await done;
  const final = JSON.parse(fs.readFileSync(file, 'utf8'));
  const total = Object.values(final.days).reduce((n, c) => n + c.runs, 0);
  assert.equal(total, 240, 'no lost summary updates');
  assert.ok(reads > 0);
});

test('S7 files have mode 0600, directories 0700', { skip: process.platform === 'win32' }, () => {
  const dir = tmpDir();
  const s = new Store(dir);
  s.append([{ type: 'start', id: 'a', ts: 1 }]);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(s.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(s.dir, 'summary.json')).mode & 0o777, 0o600);
});

test('buildRuns joins start/end and folds waits', () => {
  const runs = buildRuns([
    { type: 'start', id: 'a', ts: 1, key: 'k' },
    { type: 'end', id: 'a', ts: 5, exit: 1 },
    { type: 'wait', id: 'w', ts: 9, key: 'k', attempts: 3 },
    { type: 'start', id: 'b', ts: 10, key: 'k' },
  ]);
  assert.equal(runs.length, 3);
  assert.equal(runs[0].finished, true);
  assert.equal(runs[0].end_ts, 5);
  assert.equal(runs[0].exit, 1);
  assert.equal(runs[1].is_wait, true);
  assert.equal(runs[2].finished, false);
});
