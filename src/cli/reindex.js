// kerb reindex: rebuild .kerb/index/ from the event log (KERB-V2 5.2). Safe to run any time.
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { rebuildIndexes } from '../store/index.js';
import { parseOpts } from './args.js';

export default async function reindex(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const ix = rebuildIndexes(new Store(root));
  const counts = {
    keys: Object.keys(ix.by_key).length,
    runs: Object.values(ix.by_key).reduce((n, l) => n + l.length, 0),
    tests: Object.keys(ix.tests).length,
    states: Object.keys(ix.states).length,
    fixes: Object.values(ix.fixes.by_fingerprint).reduce((n, l) => n + l.length, 0),
  };
  if (ctx.json) { ctx.emitJson({ rebuilt: true, ...counts }); return 0; }
  ctx.out(`kerb reindex · ${counts.runs} runs in ${counts.keys} keys, ${counts.states} states, ${counts.tests} tests, ${counts.fixes} fixes\n`);
  return 0;
}
