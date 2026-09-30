// kerb init / uninstall (4.10): detect agents, merge hooks into their settings with absolute
// paths, write the instructions block and skill, and keep a manifest so uninstall restores
// every file byte for byte outside the markers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, isWindows } from '../util/core.js';
import { atomicWrite, ensureDir, readJson } from '../util/fsx.js';
import { INSTRUCTION_FILES, SKILL, START_MARKER, END_MARKER, instructionsBlock, briefingLines, replaceBlock } from './instructions.js';
import { AGENT_DESCRIPTORS } from './agents.js';

export const MANIFEST = '.kerb/install.json';

let seaBinary = null;
try {
  const sea = await import('node:sea');
  if (sea.isSea && sea.isSea()) seaBinary = process.execPath;
} catch { /* not a single-executable build */ }

/** Shell-quote a path for a hook command line. */
export function q(p) {
  if (isWindows) return `"${p}"`;
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `"${p.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * How hooks call Kerb: the standalone binary's absolute path, or Node's absolute path plus
 * Kerb's entry script, so version managers switching Node per project don't break hooks.
 */
export function kerbInvocation() {
  if (seaBinary) return { command: q(seaBinary), binary: seaBinary, node: null, script: null };
  const script = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'kerb.js'));
  const node = fs.realpathSync(process.execPath);
  return { command: `${q(node)} ${q(script)}`, binary: null, node, script };
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * @typedef {{ file: string, kind: 'json' | 'markers' | 'file' | 'lines', before: string | null, after: string,
 *   agent?: string, prefix?: string, added?: string, note?: string }} Action
 */

/** Marker block insert/replace. */
function markersAction(root, rel, block) {
  const before = readText(path.join(root, rel));
  if (before === null) return { file: rel, kind: 'markers', before, after: `${block}\n`, prefix: '' };
  const replaced = replaceBlock(before, block);
  if (replaced !== null) return { file: rel, kind: 'markers', before, after: replaced, prefix: null };
  const prefix = before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  return { file: rel, kind: 'markers', before, after: `${before}${prefix}${block}\n`, prefix };
}

function gitignoreAction(root, entries) {
  const rel = '.gitignore';
  const before = readText(path.join(root, rel));
  if (before === null && !fs.existsSync(path.join(root, '.git'))) return null;
  const have = new Set((before || '').split(/\r?\n/).map((l) => l.trim().replace(/^\//, '').replace(/\/$/, '')));
  const missing = [...new Set(entries)].filter((e) => !have.has(e.replace(/\/$/, '')));
  if (!missing.length) return null;
  const sep = before && !before.endsWith('\n') ? '\n' : '';
  const added = `${sep}${missing.join('\n')}\n`;
  return { file: rel, kind: 'lines', before, after: `${before || ''}${added}`, added };
}

/**
 * Work out every change init would make.
 * @param {string} root
 * @param {{ agents?: string[] | null, home?: string, refresh?: boolean }} o
 */
export function planInit(root, o = {}) {
  const home = o.home || os.homedir();
  const inv = kerbInvocation();
  const manifest = readJson(path.join(root, MANIFEST), null);
  const detected = AGENT_DESCRIPTORS.filter((d) => {
    if (o.agents && o.agents.length) return o.agents.includes(d.id);
    if (o.refresh && manifest) return Object.keys(manifest.agents || {}).includes(d.id);
    return d.detect(root, home);
  });
  /** @type {Action[]} */
  const actions = [];
  /** @type {Record<string, { tier: string, how: string }>} */
  const agents = {};
  const notes = [];
  const ignores = ['.kerb/'];
  for (const d of detected) {
    const r = d.plan(root, home, inv);
    actions.push(...r.actions.map((a) => ({ ...a, agent: d.id })));
    agents[d.id] = { tier: r.tier, how: r.how };
    notes.push(...(r.notes || []));
    ignores.push(...(r.gitignore || []));
  }
  // Instructions: AGENTS.md always; the others only when they exist.
  const block = instructionsBlock(briefingLines(root));
  for (const rel of INSTRUCTION_FILES) {
    const exists = fs.existsSync(path.join(root, rel));
    if (rel === 'AGENTS.md' || exists || actions.some((a) => a.file === rel)) actions.push(markersAction(root, rel, block));
  }
  // Skill wherever the agent supports skills.
  for (const d of detected) {
    for (const rel of d.skillPaths ? d.skillPaths(root) : []) {
      actions.push({ file: rel, kind: 'file', before: readText(path.join(root, rel)), after: SKILL, agent: d.id });
    }
  }
  const gi = gitignoreAction(root, ignores);
  if (gi) actions.push(gi);
  return { actions: actions.filter((a) => a.before !== a.after), unchanged: actions.filter((a) => a.before === a.after), agents, notes, inv };
}

/** Apply a plan and update the manifest (original bytes are kept for exact uninstall). */
export function applyInit(root, plan) {
  const mfile = path.join(root, MANIFEST);
  const manifest = readJson(mfile, null) || { version: 1, files: {}, agents: {} };
  for (const a of plan.actions) {
    const full = path.join(root, a.file);
    const prev = manifest.files[a.file];
    const entry = prev || {
      kind: a.kind,
      existed: a.before !== null,
      original: a.kind === 'json' && a.before !== null ? Buffer.from(a.before).toString('base64') : undefined,
      prefix: a.kind === 'markers' ? a.prefix : undefined,
      added: a.kind === 'lines' ? a.added : undefined,
      agent: a.agent,
    };
    if (a.kind === 'markers' && prev && prev.prefix == null && a.prefix != null) entry.prefix = a.prefix;
    if (a.kind === 'lines' && prev) entry.added = `${prev.added || ''}${a.added}`;
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, a.after);
    entry.written = sha256(a.after);
    manifest.files[a.file] = entry;
  }
  for (const [id, info] of Object.entries(plan.agents)) manifest.agents[id] = info;
  manifest.kerb = { node: plan.inv.node, script: plan.inv.script, binary: plan.inv.binary, command: plan.inv.command };
  manifest.updated = new Date().toISOString();
  ensureDir(path.dirname(mfile));
  atomicWrite(mfile, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function removeEmptyDirs(root, rel) {
  let dir = path.dirname(path.join(root, rel));
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length) break;
      fs.rmdirSync(dir);
    } catch { break; }
    dir = path.dirname(dir);
  }
}

/**
 * Remove everything init added. Files untouched since init are restored byte for byte;
 * edited files have only Kerb's parts removed.
 * @returns {{ file: string, action: string }[]}
 */
export function uninstall(root) {
  const mfile = path.join(root, MANIFEST);
  const manifest = readJson(mfile, null);
  const out = [];
  const files = manifest ? manifest.files : Object.fromEntries(INSTRUCTION_FILES.map((f) => [f, { kind: 'markers', existed: true }]));
  for (const [rel, entry] of Object.entries(files)) {
    const full = path.join(root, rel);
    const cur = readText(full);
    if (cur === null) continue;
    const pristine = entry.written && sha256(cur) === entry.written;
    if (entry.kind === 'file') {
      fs.unlinkSync(full);
      removeEmptyDirs(root, rel);
      out.push({ file: rel, action: 'removed' });
    } else if (entry.kind === 'json') {
      if (pristine) {
        if (entry.existed && entry.original !== undefined) fs.writeFileSync(full, Buffer.from(entry.original, 'base64'));
        else { fs.unlinkSync(full); removeEmptyDirs(root, rel); }
        out.push({ file: rel, action: entry.existed ? 'restored' : 'removed' });
      } else {
        const descriptor = AGENT_DESCRIPTORS.find((d) => d.id === (entry.agent || '')) || null;
        const stripped = stripKerbJson(cur, descriptor);
        if (stripped !== cur) fs.writeFileSync(full, stripped);
        out.push({ file: rel, action: 'kerb entries removed' });
      }
    } else if (entry.kind === 'markers') {
      const s = cur.indexOf(START_MARKER);
      const e = cur.indexOf(END_MARKER);
      if (s === -1 || e === -1) continue;
      let from = s;
      let to = e + END_MARKER.length;
      if (cur[to] === '\n') to++;
      if (entry.prefix && cur.slice(s - entry.prefix.length, s) === entry.prefix) from = s - entry.prefix.length;
      const next = cur.slice(0, from) + cur.slice(to);
      if (!entry.existed && next.trim() === '') { fs.unlinkSync(full); removeEmptyDirs(root, rel); out.push({ file: rel, action: 'removed' }); }
      else { fs.writeFileSync(full, next); out.push({ file: rel, action: 'block removed' }); }
    } else if (entry.kind === 'lines') {
      let next;
      if (entry.added && cur.endsWith(entry.added)) next = cur.slice(0, cur.length - entry.added.length);
      else {
        const ours = new Set((entry.added || '.kerb/').split('\n').map((l) => l.trim()).filter(Boolean));
        next = cur.split('\n').filter((l) => !ours.has(l.trim())).join('\n');
      }
      if (!entry.existed && next === '') { fs.unlinkSync(full); out.push({ file: rel, action: 'removed' }); }
      else { fs.writeFileSync(full, next); out.push({ file: rel, action: 'line removed' }); }
    }
  }
  try { fs.unlinkSync(mfile); } catch { /* none */ }
  return out;
}

/** Remove Kerb's hook entries and status line from an agent settings JSON (surgical path). */
export function stripKerbJson(text, descriptor) {
  let obj;
  try { obj = JSON.parse(text); } catch { return text; }
  const isKerb = (cmd) => typeof cmd === 'string' && /\bkerb(\.js)?\b/.test(cmd) && /\b(hook|statusline)\b/.test(cmd);
  if (descriptor && descriptor.strip) descriptor.strip(obj, isKerb);
  return `${JSON.stringify(obj, null, 2)}\n`;
}
