// Hook handoff records (.kerb/pending/<tool_use_id>.json): written by the pre hook, consumed by
// the post hook. They also tell a `kerb run` / `kerb wait-for` started by a hooked agent the
// agent's tool timeout, its session and its tier.
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../util/fsx.js';
import { findRoot } from '../util/repo.js';
import { kerbArgv, kerbSubcommand } from '../bound/human.js';

const MAX_AGE_MS = 10 * 60_000;

export function pendingDir(storeDir) { return path.join(storeDir, 'pending'); }

function safeName(id) {
  return String(id).replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}

export function writePending(storeDir, toolUseId, rec) {
  const dir = ensureDir(pendingDir(storeDir));
  fs.writeFileSync(path.join(dir, `${safeName(toolUseId)}.json`), JSON.stringify(rec), { mode: 0o600 });
}

/** Read and delete a pending record; null if absent. */
export function takePending(storeDir, toolUseId) {
  const file = path.join(pendingDir(storeDir), `${safeName(toolUseId)}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return rec;
  } catch {
    return null;
  }
}

/** Remove pending records older than 10 minutes (the post hook never came). */
export function prunePending(storeDir, nowTs = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(pendingDir(storeDir)); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const f = path.join(pendingDir(storeDir), name);
    try {
      if (nowTs - fs.statSync(f).mtimeMs > MAX_AGE_MS) { fs.unlinkSync(f); n++; }
    } catch { /* gone */ }
  }
  return n;
}

const norm = (s) => String(s).trim().replace(/\s+/g, ' ');

/**
 * Inner commands of `kerb run|wait-for … -- <inner>` segments in a parsed command.
 * @param {import('../parse/tokenize.js').Parsed} parsed
 */
export function kerbInnerCommands(parsed) {
  const out = [];
  for (const seg of parsed.segments) {
    const argv = kerbArgv(seg);
    if (!argv) continue;
    const { sub, rest } = kerbSubcommand(argv);
    if (sub !== 'run' && sub !== 'wait-for') continue;
    const dd = rest.indexOf('--');
    if (dd === -1) continue;
    const inner = rest.slice(dd + 1);
    if (inner.length) out.push(norm(inner.join(' ')));
  }
  return out;
}

/**
 * Hook context for a `kerb run` / `kerb wait-for` the agent started through a hooked tool call.
 * @returns {{ agent: string, session: string | null, agentTimeoutMs: number | null } | null}
 */
export function hookContextFor(cwd, command) {
  const { root } = findRoot(cwd);
  const dir = pendingDir(path.join(root, '.kerb'));
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const want = norm(command);
  let best = null;
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (!rec.kerb_inner || !rec.kerb_inner.some((c) => c === want)) continue;
      if (Date.now() - rec.wall_ts > MAX_AGE_MS) continue;
      if (!best || rec.wall_ts > best.wall_ts) best = rec;
    } catch { /* skip */ }
  }
  return best ? { agent: best.agent, session: best.session, agentTimeoutMs: best.agent_timeout_ms || null } : null;
}
