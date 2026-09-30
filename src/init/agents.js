// Agent descriptors for kerb init / uninstall / doctor. Each native adapter's install lives here;
// agents without hooks get the instructions block only (best effort).
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from '../util/core.js';

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Is an executable with this name on PATH? */
export function onPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (exists(path.join(dir, name + ext))) return true;
  }
  return false;
}

function readJsonText(root, rel) {
  let text = null;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return { text: null, obj: {} }; }
  try {
    return { text, obj: text.trim() ? JSON.parse(text) : {} };
  } catch (e) {
    throw new UsageError(`${rel} is not valid JSON (${e.message}); fix it and run kerb init again`);
  }
}

const KERB_HOOK = (agent, event) => new RegExp(`\\bhook ${agent} ${event}(\\s|$)`);

/**
 * Merge one command hook into Claude-style settings: hooks[event] = [{ matcher, hooks: [{ type, command, timeout }] }].
 * An existing Kerb entry for the same event is updated in place (idempotent, refreshes paths).
 */
function mergeClaudeStyle(obj, event, matcher, command, timeout, re) {
  obj.hooks = obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : {};
  const groups = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
  obj.hooks[event] = groups;
  for (const g of groups) {
    for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
      if (typeof h.command === 'string' && re.test(h.command)) {
        h.type = 'command';
        h.command = command;
        h.timeout = timeout;
        return;
      }
    }
  }
  groups.push(matcher ? { matcher, hooks: [{ type: 'command', command, timeout }] } : { hooks: [{ type: 'command', command, timeout }] });
}

function stripClaudeStyle(obj, isKerb) {
  if (obj.hooks && typeof obj.hooks === 'object') {
    for (const [event, groups] of Object.entries(obj.hooks)) {
      if (!Array.isArray(groups)) continue;
      const kept = [];
      for (const g of groups) {
        if (!Array.isArray(g.hooks)) { kept.push(g); continue; }
        g.hooks = g.hooks.filter((h) => !isKerb(h.command));
        if (g.hooks.length) kept.push(g);
      }
      if (kept.length) obj.hooks[event] = kept;
      else delete obj.hooks[event];
    }
    if (!Object.keys(obj.hooks).length) delete obj.hooks;
  }
  if (obj.statusLine && isKerb(obj.statusLine.command)) delete obj.statusLine;
}

/** Commands configured per event in Claude-style settings. */
function claudeStyleCommands(obj, agent, events) {
  /** @type {Record<string, string | null>} */
  const out = {};
  for (const [event, short] of Object.entries(events)) {
    out[event] = null;
    const re = KERB_HOOK(agent, short);
    for (const g of (obj.hooks && obj.hooks[event]) || []) {
      for (const h of (g && g.hooks) || []) if (typeof h.command === 'string' && re.test(h.command)) out[event] = h.command;
    }
  }
  return out;
}

const CLAUDE_EVENTS = { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'post-failure', SessionStart: 'start', Stop: 'stop' };
const CLAUDE_SETTINGS = '.claude/settings.local.json';

const claude = {
  id: 'claude',
  name: 'Claude Code',
  settingsFile: CLAUDE_SETTINGS,
  detect(root, home) {
    return exists(path.join(root, '.claude')) || exists(path.join(home, '.claude')) || exists(path.join(root, 'CLAUDE.md')) || onPath('claude');
  },
  plan(root, home, inv) {
    const { text, obj } = readJsonText(root, CLAUDE_SETTINGS);
    for (const [event, short] of Object.entries(CLAUDE_EVENTS)) {
      const matcher = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event) ? 'Bash' : null;
      mergeClaudeStyle(obj, event, matcher, `${inv.command} hook claude ${short}`, short === 'start' ? 10 : 5, KERB_HOOK('claude', short));
    }
    const notes = [];
    const isOurs = (sl) => sl && typeof sl.command === 'string' && /\bkerb(\.js)?\b/.test(sl.command) && /\bstatusline\b/.test(sl.command);
    const others = [path.join(home, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json')]
      .map((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).statusLine; } catch { return null; } })
      .filter(Boolean);
    const localIsOther = obj.statusLine && !isOurs(obj.statusLine);
    if (!others.length && !localIsOther) {
      obj.statusLine = { type: 'command', command: `${inv.command} statusline` };
    } else {
      notes.push(`Claude Code already has a status line; add Kerb's part by appending the output of \`${inv.command} statusline --segment\` to your status line command.`);
    }
    const after = `${JSON.stringify(obj, null, 2)}\n`;
    return { actions: [{ file: CLAUDE_SETTINGS, kind: 'json', before: text, after }], tier: 'enforced', how: 'native hooks', notes };
  },
  skillPaths: () => ['.claude/skills/kerb/SKILL.md'],
  strip: stripClaudeStyle,
  /** @returns {Record<string, string | null>} */
  hookCommands(root) {
    const { obj } = readJsonText(root, CLAUDE_SETTINGS);
    return claudeStyleCommands(obj, 'claude', CLAUDE_EVENTS);
  },
};

export const AGENT_DESCRIPTORS = [claude];
export { mergeClaudeStyle, stripClaudeStyle, claudeStyleCommands, readJsonText, KERB_HOOK };
