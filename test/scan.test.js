// SC · kerb scan, retroactive replay of agent transcripts (KERB-V2 10.1, tests SC1–SC10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, ROOT } from './helpers.js';
import * as claude from '../src/scan/claude.js';
import * as codex from '../src/scan/codex.js';
import * as gemini from '../src/scan/gemini.js';

const FIX = path.join(ROOT, 'test/fixtures/scan');
const SINCE = ['--since', '3650d'];

function place(repo, src, dest, root = repo.dir) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(path.join(FIX, src), 'utf8').replaceAll('__REPO__', root));
  return dest;
}

/** A repo with agent transcripts placed where each agent keeps them, under the temp HOME. */
function scanRepo({ claudeFiles = ['session-a.jsonl'], withCodex = false, withGemini = false } = {}) {
  const repo = makeRepo({ git: true });
  const env = { CLAUDE_CONFIG_DIR: path.join(repo.home, '.claude'), CODEX_HOME: path.join(repo.home, '.codex') };
  const proj = path.join(env.CLAUDE_CONFIG_DIR, 'projects', claude.encodeCwd(repo.dir));
  for (const f of claudeFiles) place(repo, `claude/${f}`, path.join(proj, f));
  if (withCodex) place(repo, 'codex/rollout-2026-09-20T10-00-00-cx-1.jsonl', path.join(env.CODEX_HOME, 'sessions/2026/09/20/rollout-2026-09-20T10-00-00-cx-1.jsonl'));
  if (withGemini) {
    const g = path.join(repo.home, '.gemini/tmp', path.basename(repo.dir).toLowerCase());
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, '.project_root'), repo.dir);
    place(repo, 'gemini/session-2026-09-20T10-00-gm1.jsonl', path.join(g, 'chats/session-2026-09-20T10-00-gm1.jsonl'));
    place(repo, 'gemini/session-2026-09-19T10-00-gm0.json', path.join(g, 'chats/session-2026-09-19T10-00-gm0.json'));
  }
  const scan = (args = []) => repo.kerb(['scan', ...SINCE, ...args], { env });
  return { repo, env, proj, scan };
}

test('SC1 Claude Code transcript fixture → the correct command timeline', () => {
  const { repo, proj } = scanRepo();
  const r = claude.readSession(path.join(proj, 'session-a.jsonl'), repo.dir);
  const shells = r.events.filter((e) => e.kind === 'shell');
  assert.equal(shells.length, 17);
  assert.deepEqual(r.events.filter((e) => e.kind !== 'shell').map((e) => `${e.kind}:${e.tool}`), ['tool:Read', 'edit:Edit']);
  const first = shells[0];
  assert.equal(first.command, 'npm test');
  assert.equal(first.exit, 1);
  assert.equal(first.end_ts - first.ts, 5000);
  assert.match(first.output, /^FAIL test\/cart\.test\.js/, 'the "Exit code N" line is not part of the output');
  assert.equal(shells.find((e) => e.command === 'npm install').exit, 0);
  const dev = shells.find((e) => e.command === 'npm run dev');
  assert.equal(dev.timed_out, true);
  assert.equal(dev.exit, null);
  assert.equal(shells.find((e) => e.command === 'sleep 30').interrupted, true);
  assert.ok(shells.every((e) => e.tokens == null || e.tokens > 0));
  assert.ok(shells.filter((e) => e.tokens != null).length >= 15, 'tokens measured from usage');
  // Sessions in a sibling directory with the same prefix are not this repo's.
  const other = path.join(path.dirname(proj), `${claude.encodeCwd(repo.dir)}-old`, 'x.jsonl');
  place(repo, 'claude/session-a.jsonl', other, `${repo.dir}-old`);
  assert.equal(claude.readSession(other, repo.dir).skipped, 'outside this repo');
});

test('SC2/SC3 identical retries count only with no edit or setup call between', () => {
  const { scan } = scanRepo();
  const j = scan(['--json']).json;
  assert.equal(j.metrics.commands, 17);
  // npm test fails, runs again (counted), a Read in between is neutral (counted), then an Edit
  // and an `npm install` each make the next run legitimate (not counted).
  assert.equal(j.metrics.identical_retries.count, 2);
  assert.equal(j.metrics.identical_retries.run_time_ms, 10_000);
  assert.ok(j.metrics.identical_retries.tokens > 0);
});

test('SC4 blocked-host retries are counted from denial signatures', () => {
  const { scan } = scanRepo();
  const m = scan(['--json']).json.metrics;
  assert.equal(m.blocked_host_retries.count, 2, 'the second curl and the npm view with --registry');
  assert.deepEqual(m.blocked_host_retries.hosts, ['registry.npmjs.org']);
});

test('SC5 TLS failures are counted', () => {
  const { scan } = scanRepo({ withGemini: true });
  const j = scan(['--json']).json;
  assert.equal(j.metrics.environment.tls_interception, 2, 'pip in Claude Code, go in the legacy Gemini file');
  assert.equal(j.ca_bundle, false);
  assert.match(scan().stdout, /2 certificate errors \(corporate TLS\)\s+no CA bundle configured/);
});

test('SC6 hangs from timeouts or interrupts', () => {
  const { scan } = scanRepo();
  const m = scan(['--json']).json.metrics;
  assert.equal(m.hangs.count, 2);
  assert.equal(m.polling.attempts_folded, 2, 'three health polls in a row fold into one wait-for');
  assert.equal(m.polling.groups, 1);
  assert.ok(m.noise.bytes_beyond_budget > 30_000);
});

test('SC7 measured tokens only when usage is present; otherwise bytes only', () => {
  const withUsage = scanRepo().scan();
  assert.match(withUsage.stdout, /of output beyond Kerb's budget\s+≈ [\d.]+k? tokens \(measured from transcripts\)/);
  const { scan } = scanRepo({ claudeFiles: ['session-no-usage.jsonl'] });
  const j = scan(['--json']).json;
  assert.equal(j.usage_recorded, false);
  assert.equal(j.metrics.noise.tokens_measured_for, 0);
  assert.equal(j.metrics.identical_retries.tokens_measured_for, 0);
  const text = scan().stdout;
  assert.doesNotMatch(text, /tokens \(measured/);
  assert.match(text, /no usage data, so only bytes are shown/);
});

test('SC8 everything is labelled "replayed"', () => {
  const { scan } = scanRepo({ withCodex: true, withGemini: true });
  const r = scan();
  assert.match(r.stdout.split('\n')[0], /^kerb scan · 3650 days · 1 Claude Code session, 1 Codex session, 2 Gemini CLI sessions in this repo \(replayed\)$/);
  assert.match(r.stdout, /^replayed: what Kerb's rules would have done; nothing was run/m);
  const j = scan(['--json']).json;
  assert.equal(j.basis, 'replayed');
  assert.equal(j.metrics.basis, 'replayed');
  // Codex: pytest failed twice (counted once); Gemini: go test failed twice; the rewound message is gone.
  assert.equal(j.metrics.identical_retries.count, 4);
});

test('Codex and Gemini readers follow the verified formats', () => {
  const { repo, env } = scanRepo({ withCodex: true, withGemini: true });
  const [cf] = codex.sessionFiles(repo.dir, { env, home: repo.home });
  const c = codex.readSession(cf.path, repo.dir);
  const cs = c.events.filter((e) => e.kind === 'shell');
  assert.deepEqual(cs.map((e) => [e.command, e.exit]), [['pytest -q', 1], ['pytest -q', 1], ['pytest -q', 0]]);
  assert.equal(cs[0].end_ts - cs[0].ts, 2500, 'duration from metadata');
  assert.equal(cs[1].tokens, 140, 'next input − this input − (output − reasoning)');
  assert.ok(c.events.some((e) => e.kind === 'edit' && e.tool === 'apply_patch'));
  assert.equal(codex.parseShellOutput('Exit code: 2\nWall time: 1.5 seconds\nOutput:\nboom').exit, 2);
  const g = gemini.sessionFiles(repo.dir, { env, home: repo.home });
  assert.equal(g.length, 2);
  const gs = gemini.readSession(g.find((f) => f.path.endsWith('.jsonl')).path, repo.dir).events;
  assert.deepEqual(gs.map((e) => [e.command, e.exit]), [['go test ./...', 1], ['go test ./...', 1]]);
  assert.match(gs[0].output, /^--- FAIL: TestCart/);
  assert.equal(gs[1].tokens, 80);
});

test('SC9 an unknown transcript format is skipped with a note, no crash', () => {
  const { scan } = scanRepo({ claudeFiles: ['session-a.jsonl', 'unknown-format.jsonl'] });
  const r = scan();
  assert.equal(r.code, 0);
  assert.match(r.stdout, /note: skipped \S*unknown-format\.jsonl \(unrecognised format\)/);
  assert.equal(scan(['--json']).json.skipped.length, 1);
  const empty = makeRepo();
  const e = empty.kerb(['scan', '--json'], { env: { CLAUDE_CONFIG_DIR: path.join(empty.home, 'nothing'), CODEX_HOME: path.join(empty.home, 'nothing') } });
  assert.equal(e.code, 0);
  assert.equal(e.json.metrics.commands, 0);
});

test('SC10 nothing is written anywhere and no network module is used', () => {
  const { repo, scan } = scanRepo({ withCodex: true, withGemini: true });
  const snapshot = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '.git') walk(p); } else { const st = fs.statSync(p); out.push(`${p} ${st.size} ${st.mtimeMs}`); }
      }
    };
    walk(repo.dir);
    walk(repo.home);
    return out.sort();
  };
  const before = snapshot();
  assert.equal(scan().code, 0);
  assert.equal(scan(['--json']).code, 0);
  assert.deepEqual(snapshot(), before);
  for (const f of ['src/cli/scan.js', ...fs.readdirSync(path.join(ROOT, 'src/scan')).map((n) => `src/scan/${n}`)]) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(text, /node:(http|https|net|dns|tls|http2|dgram)['"]|fetch\s*\(/, f);
  }
});

test('kerb card --scan renders the replayed numbers; init offers the scan', () => {
  const { repo, env } = scanRepo();
  const r = repo.kerb(['card', '--scan', '--since', '3650d', '--out', repo.home, '--json'], { env });
  assert.equal(r.code, 0);
  const svg = fs.readFileSync(r.json.svg, 'utf8');
  assert.match(svg, /What Kerb would have caught/);
  assert.match(svg, /1 agent session \(replayed\)/);
  assert.match(svg, />2<\/text>\s*<text[^>]*>re-runs with nothing changed</);
  assert.doesNotMatch(svg, /\$/, 'no dollar figure on a replayed card');
  assert.match(repo.kerb(['init', '--agent', 'claude'], { env }).stdout, /kerb scan$/m);
});
