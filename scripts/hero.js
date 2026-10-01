#!/usr/bin/env node
// Renders the README hero, docs/assets/scan-hero.svg: real `kerb scan` output on the sample
// transcripts in test/fixtures/scan (Claude Code, Codex and Gemini CLI), drawn as a terminal.
// The clock is set to 2026-09-30 so "30 days" covers the samples whenever this runs.
//   node scripts/hero.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures/scan');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-hero-')));
const repo = path.join(tmp, 'shop');
const home = path.join(tmp, 'home');
fs.mkdirSync(repo, { recursive: true });
process.env.HOME = home;
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
process.env.CODEX_HOME = path.join(home, '.codex');

const place = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, fs.readFileSync(path.join(FIX, src), 'utf8').replaceAll('__REPO__', repo));
};
const { encodeCwd } = await import('../src/scan/claude.js');
place('claude/session-a.jsonl', path.join(home, '.claude/projects', encodeCwd(repo), 'session-a.jsonl'));
place('codex/rollout-2026-09-20T10-00-00-cx-1.jsonl', path.join(home, '.codex/sessions/2026/09/20/rollout-2026-09-20T10-00-00-cx-1.jsonl'));
const g = path.join(home, '.gemini/tmp/shop');
fs.mkdirSync(g, { recursive: true });
fs.writeFileSync(path.join(g, '.project_root'), repo);
place('gemini/session-2026-09-20T10-00-gm1.jsonl', path.join(g, 'chats/session-2026-09-20T10-00-gm1.jsonl'));
place('gemini/session-2026-09-19T10-00-gm0.json', path.join(g, 'chats/session-2026-09-19T10-00-gm0.json'));

const { setClock } = await import('../src/util/core.js');
setClock(() => Date.parse('2026-09-30T12:00:00Z'));
const { runScan, renderScan } = await import('../src/cli/scan.js');
const r = await runScan(repo, { sinceMs: 30 * 86_400_000 });
const lines = ['$ kerb scan', ...renderScan(r, '30 days').split('\n'), '', '$ kerb init        # shadow mode for 7 days: records what it would stop, blocks nothing'];
fs.rmSync(tmp, { recursive: true, force: true });

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const CW = 8.4; // advance of a 14px monospace character
const LH = 22;
const width = Math.ceil(Math.max(...lines.map((l) => l.length)) * CW * 1.04) + 56;
const height = 56 + lines.length * LH + 20;
const body = lines.map((l, i) => {
  const y = 64 + i * LH;
  const fill = l.startsWith('$') ? '#9AA5B1' : i === 1 ? '#F5B301' : '#E5E7EB';
  return `  <text x="28" y="${y}" fill="${fill}" xml:space="preserve">${esc(l)}</text>`;
}).join('\n');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
  <title>kerb scan: what Kerb would have caught in past agent sessions (sample transcripts)</title>
  <rect width="${width}" height="${height}" rx="10" fill="#111827"/>
  <circle cx="22" cy="20" r="6" fill="#4B5563"/><circle cx="42" cy="20" r="6" fill="#4B5563"/><circle cx="62" cy="20" r="6" fill="#4B5563"/>
${body}
</svg>
`;
const out = path.join(ROOT, 'docs/assets/scan-hero.svg');
fs.writeFileSync(out, svg);
process.stdout.write(`${lines.join('\n')}\nwrote ${path.relative(ROOT, out)}\n`);
