import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeRepo, records } from './helpers.js';

const POLICY = { 'kerb.policy.json': JSON.stringify({ boundaries: [{ kind: 'program', pattern: 'docker' }] }) };

function activity() {
  const repo = makeRepo({ git: true, files: { ...POLICY, 'a.js': '1\n' } });
  const ran = path.join(repo.home, 'ran');
  const fail = `echo x >> ${ran}; echo "FAIL: expected 1"; seq 1 50; exit 1`;
  repo.kerb(['run', '--class', 'check', '--', fail]);
  repo.kerb(['run', '--class', 'check', '--', fail]); // identical_retry
  repo.kerb(['run', '--', 'true']);
  repo.kerb(['run', '--class', 'check', '--', fail]);
  repo.kerb(['run', '--class', 'check', '--', fail]); // identical_retry
  repo.kerb(['run', '--', 'docker ps']); // policy_blocked
  repo.kerb(['run', '--budget', '500', '--', 'seq 1 3000']);
  repo.kerb(['wait-for', '--interval', '1s', '--max', '3s', '--', 'exit 1']);
  return repo;
}

test('Q1–Q5, Q9 report: measured and estimated sections', () => {
  const repo = activity();
  const text = repo.kerb(['report']).stdout;
  assert.match(text, /^kerb report · last 7d\n\nMeasured\n/);
  assert.match(text, /\nEstimated\n  not shown: set a price/);
  assert.ok(!/turns? saved/i.test(text), 'Q4 never "turns saved"');
  const j = repo.kerb(['report', '--json', '--estimate']).json;
  const recs = records(repo.dir);
  const ends = new Map(recs.filter((r) => r.type === 'end').map((r) => [r.id, r]));
  const matched = recs.filter((r) => r.type === 'refusal' && r.matched_run).map((r) => ends.get(r.matched_run));
  assert.equal(j.measured.reruns_avoided, 2);
  assert.equal(j.measured.output_avoided_bytes, matched.reduce((n, r) => n + r.shown_bytes, 0), 'Q2');
  assert.equal(j.measured.run_time_avoided_ms, matched.reduce((n, r) => n + r.duration_ms, 0), 'Q3');
  assert.equal(j.measured.refusals_by_reason.policy_blocked, 1);
  const wait = recs.find((r) => r.type === 'wait');
  assert.equal(j.measured.polls_folded_attempts, wait.attempts - 1, 'Q9 attempts, not turns');
  assert.ok(j.measured.noise_trimmed_bytes > 0);
  assert.equal(j.estimated.price_per_mtok, 3);
  assert.match(j.estimated.formula, /× \$3 per million input tokens/);
  const est = repo.kerb(['report', '--estimate']).stdout;
  assert.match(est, /est\. input cost avoided\n  formula: .*\n  assumptions: 4 bytes per token/, 'Q5');
  assert.match(est, /polls folded\s+\d+ attempts in 1 wait-for call/);
});

test('Q6 why shows the matched run, its failure kind and the evidence', () => {
  const repo = activity();
  const refusals = records(repo.dir).filter((r) => r.type === 'refusal' && r.reason === 'identical_retry');
  const w = repo.kerb(['why', refusals[0].id]).stdout;
  assert.match(w, /^kerb why · identical_retry at /);
  assert.match(w, /matched run \S+: exit 1, ordinary failure/);
  assert.match(w, /first failing line: FAIL: expected 1/);
  assert.match(w, /evidence\s+matches run/);
  assert.match(w, /next\s+change something first/);
  assert.match(repo.kerb(['why']).stdout, /policy_blocked/, 'default: the latest refusal');
});

test('Q7 history --key filters', () => {
  const repo = activity();
  const all = repo.kerb(['history', '--json', '-n', '50']).json.entries;
  assert.ok(all.length >= 8);
  assert.ok(all[0].ts >= all[all.length - 1].ts, 'newest first');
  const key = records(repo.dir).find((r) => r.type === 'refusal' && r.reason === 'policy_blocked').key;
  const only = repo.kerb(['history', '--json', '--key', key]).json.entries;
  assert.equal(only.length, 1);
  assert.equal(only[0].reason, 'policy_blocked');
  assert.equal(repo.kerb(['history', '-n', '2']).stdout.trim().split('\n').length, 2);
});

test('Q8 status shows each agent\'s tier, coverage and hash-budget skips', () => {
  const repo = makeRepo({ git: true, files: POLICY });
  repo.kerb(['init', '--agent', 'claude']);
  for (let i = 0; i < 6; i++) {
    const p = { session_id: 's', cwd: repo.dir, tool_name: 'Bash', tool_input: { command: `echo ${i}` }, tool_use_id: `t${i}` };
    repo.kerb(['hook', 'claude', 'pre'], { input: JSON.stringify(p) });
    if (i < 5) repo.kerb(['hook', 'claude', 'post'], { input: JSON.stringify({ ...p, tool_response: { stdout: `${i}`, stderr: '', interrupted: false } }) });
  }
  const st = repo.kerb(['status']).stdout;
  assert.match(st, /Claude Code\s+enforced \(native hooks\) · 83% of 6 observed commands fully recorded/);
  assert.match(st, /loop checks skipped for the hash budget: 0/);
  assert.match(st, /boundaries {2}1 in effect \(1 from repo policy/);
  const bare = makeRepo();
  assert.match(bare.kerb(['status']).stdout, /best effort: Kerb only sees commands run through kerb run\./);
  assert.equal(bare.kerb(['status', '--json']).json.best_effort_note, 'Kerb only sees commands run through kerb run.');
});

test('status lists an open breaker until it is acknowledged', () => {
  const repo = makeRepo({ git: true, files: { 'a.js': '1\n' } });
  const ran = path.join(repo.home, 'ran');
  for (const v of ['1', '2', '3', '4']) {
    repo.write('a.js', `${v}\n`);
    repo.kerb(['run', '--class', 'check', '--', `echo x >> ${ran}; echo FAIL; exit 1`]);
  }
  const st = repo.kerb(['status', '--json']).json;
  assert.equal(st.open_breakers.length, 1);
  fs.appendFileSync(path.join(repo.dir, '.kerb/.touch'), '');
});
