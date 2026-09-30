// Shareable card (4.11.4): an SVG at 1200×628 (the LinkedIn link-image size) and an HTML page.
// Measured numbers plainly; the dollar figure only when the user set a price, marked "est.".
import { formatBytes, formatCount } from '../util/core.js';

export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/**
 * @param {{ title: string, period: string, repo: string | null, counters: any, price: number | null }} o
 */
export function renderCardSvg(o) {
  const c = o.counters;
  const stats = [
    ['re-runs avoided', String(c.reruns_avoided || 0)],
    ['polls folded', String(c.polls_folded || 0)],
    ['noise trimmed', formatBytes(c.trimmed_bytes || 0)],
    ['walls learned', String(c.walls_new || 0)],
    ['hangs killed', String(c.hangs_killed || 0)],
    ['blocked early', String((c.by_reason && c.by_reason.policy_blocked) || 0)],
  ];
  let est = null;
  if (o.price != null) {
    const tokens = Math.round(((c.avoided_bytes || 0) + (c.trimmed_bytes || 0)) / 4);
    const dollars = (tokens * o.price) / 1e6;
    est = `≈ $${dollars.toFixed(dollars < 1 ? 2 : 0)} est. input cost avoided (${formatCount(tokens)} tokens at $${o.price}/M)`;
  }
  const cells = stats.map(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 80 + col * 360;
    const y = 250 + row * 150;
    return `  <text x="${x}" y="${y}" font-size="72" font-weight="700" fill="#F5F7FA">${xmlEscape(value)}</text>
  <text x="${x}" y="${y + 40}" font-size="28" fill="#9AA5B1">${xmlEscape(label)}</text>`;
  }).join('\n');
  const sub = [o.period, o.repo].filter(Boolean).join(' · ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="628" viewBox="0 0 1200 628" font-family="${xmlEscape(FONT)}">
  <rect width="1200" height="628" fill="#111827"/>
  <rect x="0" y="0" width="1200" height="8" fill="#F5B301"/>
  <text x="80" y="110" font-size="46" font-weight="700" fill="#F5F7FA">${xmlEscape(o.title)}</text>
  <text x="80" y="160" font-size="28" fill="#9AA5B1">${xmlEscape(sub)}</text>
${cells}
  ${est ? `<text x="80" y="560" font-size="26" fill="#F5B301">${xmlEscape(est)}</text>` : ''}
  <text x="1120" y="600" font-size="22" fill="#6B7280" text-anchor="end">measured by kerb · keeps coding agents on the road</text>
</svg>
`;
}

export function renderCardHtml(svg, title) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(title)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0B0F17; }
  .card { width: 1200px; height: 628px; max-width: 100vw; }
  .card svg { width: 100%; height: auto; display: block; }
</style>
</head>
<body>
<div class="card">
${svg.replace(/^<\?xml[^>]*>\n/, '')}
</div>
</body>
</html>
`;
}
