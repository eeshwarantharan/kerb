import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, inproc } from './helpers.js';
import { renderStatusline, renderRecap } from '../src/ui/recap.js';
import { emptyCounters, emptySummary } from '../src/store/summary.js';
import { formatRefusal } from '../src/ui/format.js';

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) };

function busy(repo) {
  repo.kerb(['run', '--', 'docker ps']);
  repo.kerb(['run', '--budget', '500', '--', 'seq 1 3000']);
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
  repo.kerb(['run', '--class', 'check', '--', 'echo FAIL; exit 1']);
}

test('V1 statusline is one line under 80 characters and fast', async () => {
  const repo = makeRepo({ files: POLICY });
  busy(repo);
  const r = repo.kerb(['statusline']);
  const line = r.stdout.trimEnd();
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.length < 80, line);
  assert.match(line, /^kerb · 1 re-run avoided · [\d.]+ KB noise trimmed · 1 wall known$/);
  const t0 = process.hrtime.bigint();
  await inproc(repo, ['statusline'], {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `${ms.toFixed(1)}ms`);
});

test('V2 zero segments are dropped', () => {
  const s = emptySummary();
  assert.equal(renderStatusline(s, { counters: emptyCounters() }), 'kerb');
  const c = emptyCounters();
  c.reruns_avoided = 2;
  assert.equal(renderStatusline(s, { counters: c }), 'kerb · 2 re-runs avoided');
});

test('V3 stale-cache, error and slow-hashing warnings appear', () => {
  const s = { ...emptySummary(), org_cache_expired: true, errors: 2 };
  const c = emptyCounters();
  c.loop_skipped = 5;
  c.loop_checked = 5;
  const line = renderStatusline(s, { counters: c });
  assert.equal(line, 'kerb · org cache expired, errors logged, hashing slow, run kerb doctor');
  const slowOnly = renderStatusline(emptySummary(), { counters: c });
  assert.equal(slowOnly, 'kerb · hashing slow, run kerb doctor');
  assert.ok(line.length < 80, line);
});

test('V4 --segment prints only Kerb\'s part; status-line JSON on stdin selects the session', () => {
  const repo = makeRepo({ files: POLICY });
  busy(repo);
  const seg = repo.kerb(['statusline', '--segment']).stdout.trimEnd();
  assert.ok(!seg.startsWith('kerb'));
  assert.match(seg, /^1 re-run avoided/);
  const other = repo.kerb(['statusline'], { input: JSON.stringify({ session_id: 'unknown-session', cwd: repo.dir }) });
  assert.equal(other.stdout.trimEnd(), 'kerb · 1 wall known');
});

test('V5 the recap prints only when there was at least one save', () => {
  const quiet = makeRepo();
  quiet.kerb(['run', '--', 'true']);
  assert.equal(quiet.kerb(['recap']).stdout, '');
  const repo = makeRepo({ files: POLICY });
  busy(repo);
  const r = repo.kerb(['recap']).stdout;
  assert.match(r, /^kerb recap · this session/);
  assert.match(r, /re-runs avoided\s+1 {2}\(saved \S+ of run time, ≈ \d+ tokens? of output\)/);
  assert.match(r, /noise trimmed\s+[\d.]+ K?B → [\d.]+ K?B shown/);
});

test('V6 recap off silences it', () => {
  const repo = makeRepo({ files: POLICY });
  busy(repo);
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ recap: 'off' }));
  assert.equal(repo.kerb(['recap']).stdout, '');
  assert.equal(repo.kerb(['config', 'set', 'recap', 'on']).code, 64, 'config set is human-only');
  assert.match(repo.kerb(['config', 'get', 'recap']).stdout, /recap = off/);
});

test('V7 no colour when not a TTY or when NO_COLOR is set', () => {
  const repo = makeRepo({ files: POLICY });
  const r = repo.kerb(['run', '--', 'docker ps']);
  assert.ok(!r.stderr.includes('\x1b['));
  fs.mkdirSync(path.join(repo.home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(repo.home, '.kerb/config.json'), JSON.stringify({ color: 'always' }));
  assert.ok(repo.kerb(['run', '--', 'docker ps']).stderr.includes('\x1b[33m'));
  assert.ok(!repo.kerb(['run', '--', 'docker ps'], { env: { NO_COLOR: '1' } }).stderr.includes('\x1b['));
  assert.ok(!repo.kerb(['--no-color', 'run', '--', 'docker ps']).stderr.includes('\x1b['));
});

test('V8 refusal colours in a TTY: yellow for policy_blocked, cyan for loop reasons', () => {
  const base = { summary: 's', evidence: 'e', next: 'n', exit: 75 };
  assert.ok(formatRefusal({ ...base, reason: 'policy_blocked' }, true).startsWith('\x1b[33mkerb: policy_blocked\x1b[0m'));
  for (const reason of ['identical_retry', 'deja_vu', 'breaker_open']) {
    assert.ok(formatRefusal({ ...base, reason }, true).startsWith(`\x1b[36mkerb: ${reason}\x1b[0m`), reason);
  }
});

test('V9 recap and status show the tier', () => {
  const c = emptyCounters();
  c.refusals = 1;
  c.by_reason.policy_blocked = 1;
  assert.match(renderRecap({ tier: 'enforced', agent: 'cursor', counters: c }), /\(enforced via Cursor hooks\)/);
  assert.match(renderRecap({ tier: 'best effort', agent: null, counters: c }), /\(best effort: Kerb only sees commands run through kerb run\)/);
  const repo = makeRepo({ git: true, files: POLICY });
  repo.kerb(['init', '--agent', 'claude']);
  const st = repo.kerb(['status']);
  assert.match(st.stdout, /Claude Code\s+enforced/);
});
