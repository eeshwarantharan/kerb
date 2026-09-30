// kerb ack [key] (human-only): allow one more trial for an open breaker (4.7.7).
import { findRoot } from '../util/repo.js';
import { Store } from '../store/jsonl.js';
import { newId, now, UsageError } from '../util/core.js';
import { parseOpts } from './args.js';
import { requireHuman } from '../bound/human.js';
import { keyHistory, isFailure } from '../loop/rules.js';

/** The key of the most recent loop refusal, if any. */
export function latestRefusedKey(recs) {
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i];
    if (r.type === 'refusal' && ['breaker_open', 'identical_retry', 'deja_vu'].includes(r.reason)) return r.key;
  }
  return null;
}

/** Append an ack record for a key. Library entry point (the CLI adds the human check). */
export function ackKey(store, key) {
  const recs = store.read();
  const { window } = keyHistory(recs, key);
  const lastFail = [...window].reverse().find(isFailure);
  const rec = { type: 'ack', id: newId(), ts: now(), key, fingerprint: lastFail ? lastFail.fingerprint : null };
  store.ensure().append([rec]);
  return rec;
}

export default async function ack(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const { root } = findRoot(ctx.cwd);
  const store = new Store(root);
  const recs = store.read();
  const key = positionals.join(' ') || latestRefusedKey(recs);
  if (!key) throw new UsageError('no refused command to acknowledge; pass a key (see kerb status)');
  requireHuman('kerb ack');
  const rec = ackKey(store, key);
  if (ctx.json) ctx.emitJson({ ack: true, key, id: rec.id });
  else ctx.out(`kerb: ack · one more run of \`${key}\` is allowed\n`);
  return 0;
}
