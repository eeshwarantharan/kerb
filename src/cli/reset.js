// kerb reset [key] (human-only): clear loop state for a key, or all keys.
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { newId, now } from '../util/core.js';
import { parseOpts } from './args.js';
import { requireHuman } from '../bound/human.js';

export function resetKey(store, key) {
  const rec = { type: 'reset', id: newId(), ts: now(), key: key || null };
  store.ensure().append([rec]);
  return rec;
}

export default async function reset(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const key = positionals.join(' ') || null;
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  requireHuman('kerb reset');
  resetKey(store, key);
  if (ctx.json) ctx.emitJson({ reset: true, key });
  else ctx.out(key ? `kerb: reset · loop state cleared for \`${key}\`\n` : 'kerb: reset · loop state cleared for every command in this repo\n');
  return 0;
}
