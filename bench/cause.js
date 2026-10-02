#!/usr/bin/env node
// Cause-isolation benchmark (KERB-V2 15, "cause findings, judged against the seeded ground
// truth"). No agent is needed: each scenario starts green, gets a set of edits of which some
// are known culprits, runs the check once more (red), and lets Kerb's worker isolate the cause.
// A confirmed finding is correct when every hunk it blames contains a culprit line and every
// culprit line of its test is blamed. Controls fail only because a test is flaky: there, any
// confirmed finding is a false positive.
//
//   node bench/cause.js [--generated 24] [--seed 1] [--only id,id] [--out bench/results/cause]
//
// Scenarios: the seeded regressions in bench/tasks.js, plus generated Node (node --test) and
// pytest repos: one culprit among harmless edits, two culprits breaking two tests, and flaky
// controls. Writes rows.jsonl and summary.json; the gate (15) is precision >= 95% among
// confirmed findings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TASKS } from './tasks.js';
import { sandbox, available } from './sandbox.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kerbJs = path.join(root, 'bin', 'kerb.js');

// ---- Generated scenarios ----

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
}

/** A module of functions spaced far enough apart that every edit is its own hunk. */
function moduleSource(lang, mod, fns) {
  // Seven separator lines after each function: two edits in neighbouring functions are always
  // more than six lines apart, so git never merges them into one hunk (3 lines of context each).
  if (lang === 'node') return fns.map((f) => `export function ${f.name}(x) {\n  const base = ${f.k};\n  return x * base + ${f.c};\n}\n${'//\n'.repeat(7)}`).join('');
  return fns.map((f) => `def ${f.name}(x):\n    base = ${f.k}\n    return x * base + ${f.c}\n${'#\n'.repeat(7)}`).join('');
}
function testSource(lang, mod, fns) {
  if (lang === 'node') return `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/${mod}.js';\n${fns.map((f) => `test('${mod} ${f.name}', () => assert.equal(m.${f.name}(3), ${3 * f.k + f.c}));`).join('\n')}\n`;
  return `import ${mod}\n\n${fns.map((f) => `def test_${f.name}():\n    assert ${mod}.${f.name}(3) == ${3 * f.k + f.c}\n`).join('\n\n')}\n`;
}

/**
 * @returns {{ id: string, lang: string, test: string, setup: Function, edits: Function, culprits: Record<string, string[]>, control: boolean }}
 *   culprits: test name → culprit lines ("file:line")
 */
function generated(i, kind, lang, rand) {
  const mods = ['cart', 'user', 'price'].slice(0, 2 + Math.floor(rand() * 2));
  const spec = Object.fromEntries(mods.map((m) => [m, Array.from({ length: 4 }, (_, j) => ({ name: `${m}_f${j}`, k: 2 + Math.floor(rand() * 7), c: Math.floor(rand() * 9) }))]));
  const file = (m) => (lang === 'node' ? `src/${m}.js` : `${m}.py`);
  const testFile = (m) => (lang === 'node' ? `test/${m}.test.js` : `test_${m}.py`);
  const testId = (m, f) => (lang === 'node' ? `${m} ${f.name}` : `test_${f.name}`);
  const fnLine = (m, j) => 1 + j * (lang === 'node' ? 11 : 10); // first line of function j (a block is 11 lines in JS, 10 in Python)
  const pick = () => { const m = mods[Math.floor(rand() * mods.length)]; const j = Math.floor(rand() * 4); return { m, j, f: spec[m][j] }; };
  const culprits = {};
  const plan = []; // [file, fromText, toText]
  const used = new Set();
  const take = () => { for (;;) { const p = pick(); const k = `${p.m}:${p.j}`; if (!used.has(k)) { used.add(k); return p; } } };
  const nCulprits = kind === 'two' ? 2 : kind === 'control' ? 0 : 1;
  // Every edit is anchored on its function's whole block, which is unique by name.
  const block = (f, base = 'base', c = f.c) => (lang === 'node'
    ? `export function ${f.name}(x) {\n  const ${base} = ${f.k};\n  return x * ${base} + ${c};\n}\n`
    : `def ${f.name}(x):\n    ${base} = ${f.k}\n    return x * ${base} + ${c}\n`);
  for (let n = 0; n < nCulprits; n++) {
    const { m, j, f } = take();
    plan.push([file(m), block(f), block(f, 'base', f.c + 1)]);
    culprits[testId(m, f)] = [`${file(m)}:${fnLine(m, j) + 2}`];
  }
  // Harmless edits: a renamed local (same value), and a new helper at the end of a file.
  const nHarmless = 2 + Math.floor(rand() * 4);
  for (let n = 0; n < nHarmless; n++) {
    const { m, f } = take();
    if (rand() < 0.6) plan.push([file(m), block(f), block(f, 'factor')]);
    else plan.push([file(m), null, lang === 'node' ? `export function ${f.name}_label() {\n  return '${f.name}';\n}\n` : `def ${f.name}_label():\n    return "${f.name}"\n`]);
  }
  const control = kind === 'control';
  return {
    id: `gen-${lang}-${kind}-${i}`, lang, control, culprits,
    test: lang === 'node' ? 'node --test' : 'python3 -m pytest -q -p no:cacheprovider',
    setup: (d) => {
      if (lang === 'node') fs.writeFileSync(path.join(d, 'package.json'), '{ "type": "module" }\n');
      for (const m of mods) {
        fs.mkdirSync(path.dirname(path.join(d, file(m))), { recursive: true });
        fs.mkdirSync(path.dirname(path.join(d, testFile(m))), { recursive: true });
        fs.writeFileSync(path.join(d, file(m)), moduleSource(lang, m, spec[m]));
        fs.writeFileSync(path.join(d, testFile(m)), testSource(lang, m, spec[m]));
      }
      if (control) {
        // A test that fails on its own about half the time, with no edit to blame.
        const flaky = lang === 'node'
          ? "import { test } from 'node:test';\ntest('flaky network', () => { if (Math.random() < 0.5) throw new Error('read ECONNRESET'); });\n"
          : 'import random\n\n\ndef test_flaky_network():\n    assert random.random() >= 0.5, "connection reset"\n';
        fs.writeFileSync(path.join(d, lang === 'node' ? 'test/flaky.test.js' : 'test_flaky.py'), flaky);
      }
    },
    edits: (d) => {
      for (const [f, from, to] of plan) {
        const p = path.join(d, f);
        const s = fs.readFileSync(p, 'utf8');
        if (from === null) fs.writeFileSync(p, `${s}${to}`);
        else if (s.includes(from)) fs.writeFileSync(p, s.replace(from, to));
        else throw new Error(`${f}: edit anchor not found`);
      }
    },
  };
}

function scenarios(o) {
  const out = [];
  const have = available();
  for (const t of TASKS.filter((x) => x.seeded)) {
    if ((t.needs || []).some((n) => !have.has(n))) continue;
    out.push({ id: t.id, lang: t.lang, control: false, test: t.test, setup: t.setup, edits: t.edits, culprits: { '*': t.seeded.culprits } });
  }
  const rand = rng(o.seed);
  const kinds = ['one', 'one', 'two', 'control'];
  const langs = ['node', ...(have.has('pytest') ? ['python'] : [])];
  for (let i = 0; i < o.generated; i++) out.push(generated(i, kinds[i % kinds.length], langs[Math.floor(i / kinds.length) % langs.length], rand));
  return out;
}

// ---- Running one scenario ----

function kerb(dir, home, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [kerbJs, ...args], { cwd: dir, env: { ...process.env, HOME: home, ...extraEnv }, encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 1 << 26 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** Does a location ("file:12" or "file:12–15" or "file") contain a culprit line ("file:13")? */
export function covers(location, culprit) {
  const [cf, cl] = [culprit.slice(0, culprit.lastIndexOf(':')), Number(culprit.slice(culprit.lastIndexOf(':') + 1))];
  const m = /^(.*?)(?::(\d+)(?:–(\d+))?)?$/.exec(location);
  if (!m || m[1] !== cf) return false;
  if (!m[2]) return true; // a whole-file hunk
  const a = Number(m[2]);
  const b = m[3] ? Number(m[3]) : a;
  return cl >= a && cl <= b;
}

/** Judge one finding against the ground truth. */
export function judge(finding, scenario) {
  // Test ids are <framework>:<file>::<name>; the file part can be empty (node --test without a file).
  const name = finding.test_id.replace(/^[^:]+:[^:]*::/, '');
  const truth = scenario.culprits['*'] || scenario.culprits[name] || scenario.culprits[name.replace(/^.*? > /, '')] || [];
  if (finding.confidence !== 'confirmed') return { counted: false, correct: null, truth };
  if (scenario.control || !truth.length) return { counted: true, correct: false, truth, why: 'no edit is to blame' };
  const innocent = finding.locations.filter((l) => !truth.some((c) => covers(l, c)));
  const missed = truth.filter((c) => !finding.locations.some((l) => covers(l, c)));
  // Exact: each blamed hunk is just culprit lines (a merged hunk can hold innocent lines too).
  const exact = !innocent.length && !missed.length && finding.locations.every((l) => { const m = /:(\d+)(?:–(\d+))?$/.exec(l); if (!m) return false; const a = Number(m[1]); const b = Number(m[2] || m[1]); for (let x = a; x <= b; x++) if (!truth.some((c) => covers(`${l.replace(/:\d+(?:–\d+)?$/, '')}:${x}`, c))) return false; return true; });
  return { counted: true, correct: !innocent.length && !missed.length, exact, truth, innocent, missed };
}

function runScenario(s, o) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-cause-home-')));
  fs.mkdirSync(path.join(home, '.kerb'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kerb', 'config.json'), JSON.stringify({ mode: 'enforce', cause: 'on', worker: 'manual', insights: 'on' }));
  const box = sandbox({ id: s.id, setup: s.setup }, {}, { ...process.env, HOME: home });
  const t0 = Date.now();
  const env = o.env || {};
  const green = kerb(box.dir, home, ['run', '--class', 'check', '--', s.test], env);
  s.edits(box.dir);
  // Controls: run until the flaky test fails, as an agent would see it.
  let red = kerb(box.dir, home, ['run', '--class', 'check', '--', s.test], env);
  for (let i = 0; s.control && red.code === 0 && i < 8; i++) red = kerb(box.dir, home, ['run', '--class', 'check', '--', s.test], env);
  const jobs = JSON.parse(kerb(box.dir, home, ['jobs', '--json']).stdout || '{"jobs":[]}').jobs || [];
  const w = kerb(box.dir, home, ['worker', '--once', '--json'], env);
  const findings = JSON.parse(kerb(box.dir, home, ['query', 'findings']).stdout || '{"findings":[]}').findings;
  const judged = findings.map((f) => ({ test: f.test_id, confidence: f.confidence, locations: f.locations, probes: f.probes, reason: f.reason_if_undetermined, ...judge(f, s) }));
  const row = {
    scenario: s.id, lang: s.lang, control: s.control, culprits: s.culprits, green_exit: green.code, red_exit: red.code,
    cause_jobs: jobs.filter((j) => j.kind === 'cause').length, worker: (() => { try { return JSON.parse(w.stdout); } catch { return null; } })(),
    findings: judged, ms: Date.now() - t0,
  };
  if (!o.keep) { fs.rmSync(box.dir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); } else row.dir = box.dir;
  return row;
}

export function summarize(rows) {
  const confirmed = rows.flatMap((r) => r.findings.filter((f) => f.counted));
  const correct = confirmed.filter((f) => f.correct);
  const withCulprits = rows.filter((r) => !r.control);
  const expected = withCulprits.reduce((n, r) => n + Object.keys(r.culprits).length, 0);
  const found = withCulprits.reduce((n, r) => n + r.findings.filter((f) => f.correct).length, 0);
  const precision = confirmed.length ? correct.length / confirmed.length : null;
  return {
    scenarios: rows.length, controls: rows.filter((r) => r.control).length,
    confirmed_findings: confirmed.length, correct_findings: correct.length, exact_findings: confirmed.filter((f) => f.exact).length,
    undetermined_findings: rows.reduce((n, r) => n + r.findings.filter((f) => !f.counted).length, 0),
    false_positives_in_controls: rows.filter((r) => r.control).reduce((n, r) => n + r.findings.filter((f) => f.counted).length, 0),
    precision, recall: expected ? found / expected : null,
    gate: { precision_at_least_95: precision != null && precision >= 0.95 },
    wrong: confirmed.filter((f) => !f.correct).map((f) => ({ test: f.test, locations: f.locations, truth: f.truth, why: f.why || null })),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
  const o = { generated: Number(opt('generated', 24)), seed: Number(opt('seed', 1)), keep: args.includes('--keep') };
  const only = opt('only') ? opt('only').split(',') : null;
  const outDir = path.resolve(root, opt('out', 'bench/results/cause'));
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const s of scenarios(o).filter((x) => !only || only.includes(x.id))) {
    const row = runScenario(s, o);
    rows.push(row);
    const f = row.findings.map((x) => `${x.confidence}${x.counted ? (x.correct ? (x.exact ? ' ✓' : ' ✓ (wider hunk)') : ' ✗') : ''} ${x.locations.join(', ')}`).join('; ') || 'no finding';
    console.log(`${row.scenario}: ${f} (${Math.round(row.ms / 1000)} s)`);
    fs.writeFileSync(path.join(outDir, 'rows.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  }
  const summary = { date: new Date().toISOString(), kerb: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, platform: `${process.platform}-${process.arch}`, node: process.version, seed: o.seed, ...summarize(rows) };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}
