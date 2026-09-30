// kerb review --denials <file…> [--out dir] [--min-machines 3]: turn exported denials into a
// proposed policy patch and a Markdown summary for the admin.
import fs from 'node:fs';
import path from 'node:path';
import { now, UsageError } from '../util/core.js';
import { findRoot } from '../util/repo.js';
import { loadConfig } from '../config.js';
import { loadPolicy } from '../bound/load.js';
import { readExports, reviewDenials, reviewMarkdown, MIN_MACHINES } from '../bound/review.js';

export default async function review(ctx, args) {
  const files = [];
  let out = '.';
  let min = MIN_MACHINES;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--denials') { while (args[i + 1] && !args[i + 1].startsWith('--')) files.push(args[++i]); continue; }
    if (a === '--out') { out = args[++i]; continue; }
    if (a === '--min-machines') { min = Number(args[++i]); continue; }
    throw new UsageError(`unknown option: ${a}`);
  }
  if (!files.length) throw new UsageError('usage: kerb review --denials <file…> [--out dir]');
  if (!Number.isInteger(min) || min < 1) throw new UsageError('--min-machines takes a positive whole number');
  const entries = readExports(files.map((f) => path.resolve(ctx.cwd, f)));
  const policy = loadPolicy(findRoot(ctx.cwd).root, loadConfig(), now());
  const r = reviewDenials(entries, policy, min);
  const dir = path.resolve(ctx.cwd, out);
  fs.mkdirSync(dir, { recursive: true });
  const patchPath = path.join(dir, 'policy.patch.json');
  const mdPath = path.join(dir, 'review.md');
  fs.writeFileSync(patchPath, `${JSON.stringify(r.patch, null, 2)}\n`);
  fs.writeFileSync(mdPath, `${reviewMarkdown(r, { sources: files.length, minMachines: min })}\n`);
  if (ctx.json) {
    ctx.emitJson({ patch: patchPath, summary: mdPath, candidates: r.candidates, already_blocked: r.alreadyBlocked, below_threshold: r.belowThreshold });
    return 0;
  }
  ctx.out(`kerb review · ${r.candidates.length} host${r.candidates.length === 1 ? '' : 's'} proposed from ${entries.length} entries in ${files.length} file${files.length === 1 ? '' : 's'}\n`);
  ctx.out(`  wrote ${patchPath}\n  wrote ${mdPath}\n`);
  return 0;
}
