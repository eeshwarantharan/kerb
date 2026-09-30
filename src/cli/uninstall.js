// kerb uninstall (human-only): remove everything init added, using its manifest and markers.
import { findRoot } from '../util/repo.js';
import { parseOpts } from './args.js';
import { requireHuman } from '../bound/human.js';
import { uninstall } from '../init/install.js';

export default async function uninstallCmd(ctx, args) {
  parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  requireHuman('kerb uninstall');
  const done = uninstall(root);
  if (ctx.json) ctx.emitJson({ root, files: done });
  else {
    ctx.out(`kerb uninstall · ${root}\n`);
    if (!done.length) ctx.out('  nothing to remove\n');
    for (const d of done) ctx.out(`  ${d.action} ${d.file}\n`);
    ctx.out('  .kerb/ (history and logs) was left in place; delete it if you no longer want it\n');
  }
  return 0;
}
