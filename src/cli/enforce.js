// kerb enforce (human-only): end shadow mode for this repo and turn refusals on (KERB-V2 10.2).
import { findRoot } from '../util/repo.js';
import { now, UsageError } from '../util/core.js';
import { loadConfig } from '../config.js';
import { requireHuman } from '../bound/human.js';
import { effectiveMode, setEnforce } from '../mode.js';
import { parseOpts } from './args.js';

export default async function enforce(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const config = loadConfig();
  const m = effectiveMode(root, config, now());
  if (m.source === 'managed') throw new UsageError(`the mode is ${m.mode}, set by your organisation's managed config`);
  if (m.mode === 'enforce' && m.source === 'repo') {
    if (ctx.json) ctx.emitJson({ mode: 'enforce', changed: false });
    else ctx.out('kerb: enforce · already on for this repo\n');
    return 0;
  }
  requireHuman('kerb enforce');
  setEnforce(root, now());
  if (ctx.json) ctx.emitJson({ mode: 'enforce', changed: true });
  else ctx.out('kerb: enforce · on for this repo; Kerb now refuses blocked actions and retries that cannot help\n');
  return 0;
}
