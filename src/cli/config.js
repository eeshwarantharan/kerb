// kerb config get|set <key> [value]: user settings (4.13). `set` is human-only.
import { UsageError } from '../util/core.js';
import { parseOpts } from './args.js';
import { requireHuman } from '../bound/human.js';
import { CONFIG_KEYS, loadConfig, setUserConfig } from '../config.js';

export default async function config(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const [sub, key, value] = positionals;
  const cfg = loadConfig();
  if (sub === 'get' || !sub) {
    if (key && !(key in CONFIG_KEYS)) throw new UsageError(`unknown config key: ${key}. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    const out = key ? { [key]: cfg.values[key] } : cfg.values;
    if (ctx.json) ctx.emitJson({ values: out, locked: [...cfg.locked] });
    else for (const [k, v] of Object.entries(out)) ctx.out(`${k} = ${v === null ? '(unset)' : v}${cfg.locked.has(k) ? '  (locked by your organisation)' : ''}\n`);
    return 0;
  }
  if (sub === 'set') {
    if (!key || value === undefined) throw new UsageError('usage: kerb config set <key> <value>');
    if (!(key in CONFIG_KEYS)) throw new UsageError(`unknown config key: ${key}. Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    if (cfg.locked.has(key)) throw new UsageError(`${key} is locked by your organisation's managed config`);
    requireHuman('kerb config set');
    const v = setUserConfig(key, value);
    if (ctx.json) ctx.emitJson({ key, value: v });
    else ctx.out(`kerb: config · ${key} = ${v}\n`);
    return 0;
  }
  throw new UsageError('usage: kerb config get|set <key> [value]');
}
