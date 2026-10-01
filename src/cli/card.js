// kerb card [--week|--session] [--out dir] [--anonymous]: shareable SVG and HTML card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRoot } from '../util/repo.js';
import { now, parseDuration, UsageError } from '../util/core.js';
import { loadSummary, currentSession, rangeTotals } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderCardSvg, renderCardHtml, scanStats } from '../ui/card.js';
import { onPath } from '../init/agents.js';
import { parseOpts } from './args.js';

/** Try rsvg-convert, then macOS qlmanage. Returns the PNG path or null. */
function toPng(svgPath, pngPath) {
  if (onPath('rsvg-convert')) {
    const r = spawnSync('rsvg-convert', ['-w', '1200', '-h', '628', '-o', pngPath, svgPath], { stdio: 'ignore', timeout: 20_000 });
    if (r.status === 0 && fs.existsSync(pngPath)) return pngPath;
  }
  if (onPath('qlmanage')) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kerb-card-'));
    const r = spawnSync('qlmanage', ['-t', '-s', '1200', '-o', dir, svgPath], { stdio: 'ignore', timeout: 20_000 });
    const out = path.join(dir, `${path.basename(svgPath)}.png`);
    if (r.status === 0 && fs.existsSync(out)) {
      fs.copyFileSync(out, pngPath);
      fs.rmSync(dir, { recursive: true, force: true });
      return pngPath;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return null;
}

export default async function card(ctx, args) {
  const { opts } = parseOpts(args, { week: 'bool', session: 'bool', scan: 'bool', since: 'string', out: 'string', anonymous: 'bool' });
  if ([opts.week, opts.session, opts.scan].filter(Boolean).length > 1) throw new UsageError('choose one of --week, --session or --scan');
  if (opts.since && !opts.scan) throw new UsageError('--since goes with --scan');
  const { root } = findRoot(ctx.cwd);
  const summary = loadSummary(path.join(root, '.kerb'));
  const session = !!opts.session;
  let counters = session ? currentSession(summary).counters : rangeTotals(summary, now(), 7);
  const priceSetting = loadConfig().values['price.input_per_mtok'];
  let svg;
  if (opts.scan) {
    // What Kerb would have caught in past sessions (KERB-V2 10.1): replayed, never priced.
    const since = opts.since || '30d';
    let sinceMs;
    try { sinceMs = parseDuration(since); } catch { throw new UsageError(`--since takes a duration like 30d (got ${since})`); }
    const { runScan } = await import('./scan.js');
    const r = await runScan(root, { sinceMs, env: ctx.env });
    const sessions = Object.values(r.agents).reduce((n, a) => n + a.sessions, 0);
    counters = r.metrics;
    svg = renderCardSvg({
      title: 'What Kerb would have caught',
      period: `the last ${/^\d+d$/.test(since) ? `${parseInt(since, 10)} days` : since} · ${sessions} agent session${sessions === 1 ? '' : 's'} (replayed)`,
      repo: opts.anonymous ? null : path.basename(root),
      counters: {},
      stats: scanStats(r.metrics),
      price: null,
      footer: 'replayed by kerb from local transcripts · nothing left the machine',
    });
  } else {
    svg = renderCardSvg({
      title: 'Kerb kept my coding agent on the road',
      period: session ? 'this session' : 'the last 7 days',
      repo: opts.anonymous ? null : path.basename(root),
      counters,
      price: priceSetting != null ? Number(priceSetting) : null,
    });
  }
  const outDir = path.resolve(ctx.cwd, opts.out || '.');
  fs.mkdirSync(outDir, { recursive: true });
  const svgPath = path.join(outDir, 'kerb-card.svg');
  const htmlPath = path.join(outDir, 'kerb-card.html');
  fs.writeFileSync(svgPath, svg);
  fs.writeFileSync(htmlPath, renderCardHtml(svg, 'Kerb card'));
  const png = toPng(svgPath, path.join(outDir, 'kerb-card.png'));
  if (ctx.json) {
    ctx.emitJson({ svg: svgPath, html: htmlPath, png, counters });
    return 0;
  }
  ctx.out(`kerb card · wrote ${svgPath} and ${htmlPath}${png ? ` and ${png}` : ''}\n`);
  if (!png) ctx.out('  open kerb-card.html and take a screenshot\n');
  return 0;
}
