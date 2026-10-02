// kerb worker [status|stop] [--idle 60s] [--once]: the background worker (KERB-V2 8.1). Hooks
// start it when jobs are queued; it exits after 60 s idle.
import { findRoot } from '../util/repo.js';
import { parseDuration, UsageError } from '../util/core.js';
import { loadConfig } from '../config.js';
import { runWorker, workerPid, workerEnabled, budgetLeftMs } from '../worker/main.js';
import { listJobs } from '../worker/queue.js';
import { parseOpts } from './args.js';

export default async function worker(ctx, args) {
  const { opts, positionals } = parseOpts(args, { idle: 'string', once: 'bool' });
  const [sub] = positionals;
  const { root } = findRoot(ctx.cwd);
  const config = loadConfig();
  if (sub === 'status' || sub === 'stop') {
    const pid = workerPid(root);
    if (sub === 'stop') {
      if (pid) try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
      if (ctx.json) ctx.emitJson({ stopped: !!pid, pid });
      else ctx.out(pid ? `kerb worker · stopping (pid ${pid})\n` : 'kerb worker · not running\n');
      return 0;
    }
    const jobs = listJobs(root);
    const by = (s) => jobs.filter((j) => j.state === s).length;
    const running = jobs.find((j) => j.state === 'running') || null;
    const st = { running: !!pid, pid, enabled: workerEnabled(config, ctx.env), cause: config.values.cause, queued: by('queued'), current: running && { id: running.id, kind: running.kind },
      budget_left_ms: budgetLeftMs(root, config) };
    if (ctx.json) { ctx.emitJson(st); return 0; }
    ctx.out(`kerb worker · ${pid ? `running (pid ${pid})` : 'not running'}${st.enabled ? '' : ' · off'}\n`);
    ctx.out(`  queued ${st.queued}${running ? ` · now: ${running.kind} ${running.id}` : ''} · budget left this hour ${Math.round(st.budget_left_ms / 60_000)} min\n`);
    ctx.out(`  cause isolation for tests: ${config.values.cause}${config.values.cause === 'off' ? ' (kerb config set cause on)' : ''}\n`);
    return 0;
  }
  if (sub) throw new UsageError('usage: kerb worker [status|stop] [--idle 60s] [--once]');
  let idleMs;
  if (opts.idle) { try { idleMs = parseDuration(opts.idle); } catch { throw new UsageError(`--idle takes a duration (got ${opts.idle})`); } }
  const r = await runWorker({ root, config, env: ctx.env, idleMs, once: !!opts.once });
  if (ctx.json) ctx.emitJson(r);
  else if (r.reason === 'another worker is running') ctx.out('kerb worker · another worker is running for this repo\n');
  return 0;
}
