// Verification status (KERB-V2 7.2): for each tracked check key, is its last result about the
// files as they are now? green / red (last run passed / failed on the current state), stale (the
// files changed since; up to 5 named), never (not run this session).
import path from 'node:path';
import { parseCommand } from '../parse/tokenize.js';
import { checkSegment, compileCheckCommands } from '../parse/classify-cmd.js';
import { computeScope } from '../loop/scope.js';
import { envStamp } from '../loop/envstamp.js';
import { hashWorkspace } from '../loop/workspace.js';
import { readState, diffStates, treeOf } from '../state/keep.js';
import { keyRuns, isSuccess, keyCommand, endTs } from './history.js';

/** The current state of a key's scope, computed the way the key's own runs were. */
export function currentState(root, git, key, policy, env, budgetMs = 2000) {
  const cut = key.indexOf('::');
  const cwdRel = cut === -1 ? '.' : key.slice(0, cut);
  const cwd = path.resolve(root, cwdRel === '.' ? '' : cwdRel);
  const parsed = parseCommand(keyCommand(key), { cwd });
  const seg = checkSegment(parsed, compileCheckCommands(policy.check_commands));
  const scope = computeScope(root, seg ? seg.cwd : cwd, policy);
  const stamp = envStamp(env, policy, [scope.pkgRoot, root]);
  return hashWorkspace({ root, git, policy, env, envStamp: stamp, store: true }, scope, budgetMs);
}

/** Files that differ between a kept state and a freshly computed one (at most `max`). */
export function changedSince(root, stateId, cur, max = 5) {
  const a = readState(root, stateId);
  if (!a || !cur || !cur.snapshot) return [];
  const b = { ...cur.snapshot, tree: cur.snapshot.mode === 'git' ? treeOf(root, cur.snapshot) : undefined };
  const files = diffStates(root, a, b) || [];
  return files.slice(0, max);
}

/** Keys to track: check keys run in the session, plus policy `verify_keys` (commands or keys). */
export function trackedKeys(recs, session, policy) {
  const keys = new Set();
  for (const r of recs) if (r.type === 'start' && r.class === 'check' && session && r.session === session) keys.add(r.key);
  const all = new Set(recs.filter((r) => r.type === 'start' && r.class === 'check').map((r) => r.key));
  for (const v of policy.verify_keys || []) {
    const match = [...all].filter((k) => k === v || keyCommand(k) === v);
    if (match.length) match.forEach((k) => keys.add(k));
    else keys.add(v.includes('::') ? v : `.::${v}`);
  }
  return [...keys];
}

/**
 * @param {{ root: string, git: boolean, recs: any[], session: string | null, policy: any,
 *   env: NodeJS.ProcessEnv, keys?: string[], budgetMs?: number, anySession?: boolean }} o
 *   anySession: judge each key by its last run even if it wasn't in this session
 * @returns {{ key: string, command: string, status: 'green'|'red'|'stale'|'never'|'unknown',
 *   run: string | null, ts: number | null, files: string[], last_green: { run: string, ts: number, files: string[] } | null }[]}
 */
export function verification(o) {
  const out = [];
  for (const key of o.keys || trackedKeys(o.recs, o.session, o.policy)) {
    const runs = keyRuns(o.recs, key);
    const last = runs[runs.length - 1] || null;
    const item = { key, command: keyCommand(key), status: 'never', run: last ? last.id : null, ts: last ? endTs(last) : null, files: [], last_green: null };
    const inSession = o.anySession || runs.some((r) => o.session && r.session === o.session);
    if (!last || !inSession) { out.push(item); continue; }
    const cur = currentState(o.root, o.git, key, o.policy, o.env, o.budgetMs);
    if (!cur.hash) { item.status = 'unknown'; out.push(item); continue; }
    item.current = cur.hash;
    if (cur.hash === last.post_hash) item.status = isSuccess(last) ? 'green' : 'red';
    else {
      item.status = 'stale';
      item.files = changedSince(o.root, last.post_hash, cur);
      const green = [...runs].reverse().find(isSuccess);
      if (green) item.last_green = { run: green.id, ts: endTs(green), files: green.post_hash === last.post_hash ? item.files : changedSince(o.root, green.post_hash, cur) };
    }
    out.push(item);
  }
  return out;
}

/** "tests are stale: last green before you edited pricing.ts" and friends; null when nothing to say. */
export function verificationLine(v) {
  const names = (files) => files.map((f) => path.basename(f)).join(', ');
  if (v.status === 'stale') {
    if (v.last_green && v.last_green.files.length) return `${v.command} is stale: last green before you edited ${names(v.last_green.files)}`;
    return `${v.command} is stale: the files changed since it last ran${v.files.length ? ` (${names(v.files)})` : ''}`;
  }
  if (v.status === 'red') return `${v.command} fails on the current files`;
  return null;
}
