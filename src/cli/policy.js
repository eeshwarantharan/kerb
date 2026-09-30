// kerb policy keygen|sign|verify|lint: tools for platform teams (4.8.4).
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../util/core.js';
import { findRoot } from '../util/repo.js';
import { parseOpts } from './args.js';
import { lintPolicy, REPO_POLICY_FILE } from '../bound/policy.js';

export default async function policy(ctx, args) {
  const [sub, ...rest] = args;
  if (sub === 'lint') return lint(ctx, rest);
  if (sub === 'keygen' || sub === 'sign' || sub === 'verify') {
    const org = await import('../bound/org.js');
    return org.policyCommand(ctx, sub, rest);
  }
  throw new UsageError('usage: kerb policy keygen|sign|verify|lint');
}

function lint(ctx, args) {
  const { positionals } = parseOpts(args, {});
  const file = positionals[0]
    ? path.resolve(ctx.cwd, positionals[0])
    : path.join(findRoot(ctx.cwd).root, REPO_POLICY_FILE);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    throw new UsageError(`no policy file at ${file}`);
  }
  let problems;
  let obj;
  try {
    obj = JSON.parse(text);
    // A signed bundle carries the policy inside its payload.
    if (obj && typeof obj.payload === 'string' && typeof obj.signature === 'string') {
      obj = JSON.parse(Buffer.from(obj.payload, 'base64').toString('utf8')).policy;
    }
    problems = lintPolicy(obj);
  } catch (e) {
    problems = [{ level: 'error', message: `invalid JSON: ${e.message}` }];
  }
  const errors = problems.filter((p) => p.level === 'error');
  if (ctx.json) {
    ctx.emitJson({ file, ok: errors.length === 0, problems });
    return errors.length ? 1 : 0;
  }
  if (!problems.length) ctx.out(`kerb policy lint · ${path.basename(file)} is valid\n`);
  for (const p of problems) ctx.out(`${p.level}: ${p.message}\n`);
  if (problems.length) ctx.out(`kerb policy lint · ${errors.length} error${errors.length === 1 ? '' : 's'}, ${problems.length - errors.length} warning${problems.length - errors.length === 1 ? '' : 's'}\n`);
  return errors.length ? 1 : 0;
}
