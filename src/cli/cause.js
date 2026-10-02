// kerb cause [test]: the latest cause finding (or the latest for one test): which of the edits
// broke it, confirmed by probes, or why it couldn't be isolated (KERB-V2 8.2, 10.4).
import { openQuery } from '../platform/query.js';
import { findingLines } from '../insight/triggers.js';
import { parseOpts } from './args.js';

export default async function cause(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const test = positionals.join(' ') || null;
  const r = openQuery({ cwd: ctx.cwd, env: ctx.env }).findings({ test, limit: 1 });
  const f = r.findings[0] || null;
  if (ctx.json) { ctx.emitJson({ finding: f }); return 0; }
  if (!f) {
    ctx.out(`kerb cause · no cause finding${test ? ` for ${test}` : ''} yet${test ? '' : ' (the worker looks for one when a test that passed starts failing; a person can turn it on for tests with kerb config set cause on)'}\n`);
    return 0;
  }
  ctx.out(`${findingLines(f).join('\n')}\n  details: kerb show f:${f.id.slice(0, 6)}\n`);
  return 0;
}
