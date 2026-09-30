// kerb card [--week|--session] [--out dir] [--anonymous]: shareable SVG and HTML card.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findRoot } from '../util/repo.js';
import { now, UsageError } from '../util/core.js';
import { loadSummary, currentSession, rangeTotals } from '../store/summary.js';
import { loadConfig } from '../config.js';
import { renderCardSvg, renderCardHtml } from '../ui/card.js';
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
  const { opts } = parseOpts(args, { week: 'bool', session: 'bool', out: 'string', anonymous: 'bool' });
  if (opts.week && opts.session) throw new UsageError('choose --week or --session');
  const { root } = findRoot(ctx.cwd);
  const summary = loadSummary(path.join(root, '.kerb'));
  const session = !!opts.session;
  const counters = session ? currentSession(summary).counters : rangeTotals(summary, now(), 7);
  const priceSetting = loadConfig().values['price.input_per_mtok'];
  const svg = renderCardSvg({
    title: 'Kerb kept my coding agent on the road',
    period: session ? 'this session' : 'the last 7 days',
    repo: opts.anonymous ? null : path.basename(root),
    counters,
    price: priceSetting != null ? Number(priceSetting) : null,
  });
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
