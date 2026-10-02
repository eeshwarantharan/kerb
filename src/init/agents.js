// Agent descriptors for kerb init / uninstall / doctor. Each native adapter's install lives here;
// agents without hooks get the instructions block only (best effort).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { UsageError } from '../util/core.js';
import { pluginSource } from '../adapters/opencode.js';

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

const CLAUDE_EVENTS = { PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'post-failure', SessionStart: 'start', Stop: 'stop', SessionEnd: 'end' };
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
      mergeClaudeStyle(obj, event, matcher, `${inv.command} hook claude ${short}`, short === 'start' || short === 'end' ? 10 : 5, KERB_HOOK('claude', short));
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
    const m = mcpJson(root, '.mcp.json', 'mcpServers', { type: 'stdio', ...mcpLaunch(root, inv) }, `Add it for yourself: claude mcp add --scope local kerb -- ${mcpCommandLine(root, inv)}`);
    return { actions: [{ file: CLAUDE_SETTINGS, kind: 'json', before: text, after }, ...m.actions], tier: 'enforced', how: 'native hooks', notes: [...notes, ...m.notes], gitignore: m.gitignore };
  },
  skillPaths: () => ['.claude/skills/kerb/SKILL.md'],
  strip: stripClaudeStyle,
  /** @returns {Record<string, string | null>} */
  hookCommands(root) {
    const { obj } = readJsonText(root, CLAUDE_SETTINGS);
    return claudeStyleCommands(obj, 'claude', CLAUDE_EVENTS);
  },
};

/** Is this path tracked by git? (Absolute hook paths shouldn't be committed.) */
export function gitTracked(root, rel) {
  if (!exists(path.join(root, '.git'))) return false;
  const r = spawnSync('git', ['-C', root, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore' });
  return r.status === 0;
}

function trackedNote(root, rel, before) {
  return before !== null && gitTracked(root, rel)
    ? [`${rel} is committed; Kerb's hook entries contain absolute paths for this machine, so keep them out of shared commits.`]
    : [];
}

/** How an agent starts Kerb's MCP server (11.2): absolute paths, the repo as --cwd. */
export function mcpLaunch(root, inv) {
  return inv.binary ? { command: inv.binary, args: ['--cwd', root, 'mcp'] } : { command: inv.node, args: [inv.script, '--cwd', root, 'mcp'] };
}

/** The one-line command that starts the server, for agents Kerb doesn't configure itself. */
export function mcpCommandLine(root, inv) {
  const l = mcpLaunch(root, inv);
  return [l.command, ...l.args].map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a}"`)).join(' ');
}

/** Is this server entry Kerb's? */
export function isKerbMcp(e) {
  return !!e && typeof e === 'object' && /\bkerb(\.js|\.cjs)?\b/.test(JSON.stringify([e.command, e.args])) && JSON.stringify(e.args || e.command || []).includes('"mcp"');
}

/**
 * Register Kerb's MCP server in a JSON file under `servers[key].kerb`. A file committed to git is
 * left alone (the entry holds this machine's paths); the note says how to add it instead.
 * @returns {{ actions: any[], notes: string[], gitignore: string[] }}
 */
function mcpJson(root, rel, key, entry, insteadNote) {
  const { text, obj } = readJsonText(root, rel);
  if (text !== null && gitTracked(root, rel)) return { actions: [], notes: [`${rel} is committed, so Kerb didn't add its MCP server there (it holds this machine's paths). ${insteadNote}`], gitignore: [] };
  obj[key] = obj[key] && typeof obj[key] === 'object' ? obj[key] : {};
  obj[key].kerb = entry;
  return { actions: [{ file: rel, kind: 'json', before: text, after: `${JSON.stringify(obj, null, 2)}\n` }], notes: [], gitignore: text === null ? [rel] : [] };
}

/** Remove Kerb's MCP server entries (mcpServers, servers, mcp) from a parsed JSON file. */
export function stripKerbMcp(obj) {
  for (const key of ['mcpServers', 'servers', 'mcp']) {
    const m = obj[key];
    if (!m || typeof m !== 'object' || !isKerbMcp(m.kerb)) continue;
    delete m.kerb;
    if (!Object.keys(m).length) delete obj[key];
  }
}

// ---------------------------------------------------------------------------
// GitHub Copilot: one Copilot-format file read by Copilot CLI and the VS Code Local agent.

const COPILOT_FILE = '.github/hooks/kerb.json';
const COPILOT_EVENTS = { sessionStart: 'start', preToolUse: 'pre', postToolUse: 'post', postToolUseFailure: 'post-failure', agentStop: 'stop', sessionEnd: 'end' };

const copilot = {
  id: 'copilot',
  name: 'GitHub Copilot',
  settingsFile: COPILOT_FILE,
  detect(root, home) {
    return exists(path.join(root, '.github', 'copilot-instructions.md')) || exists(path.join(root, '.github', 'hooks'))
      || exists(path.join(home, '.copilot')) || onPath('copilot');
  },
  plan(root, home, inv) {
    const before = readText(path.join(root, COPILOT_FILE));
    const hooks = {};
    for (const [event, short] of Object.entries(COPILOT_EVENTS)) {
      const cmd = `${inv.command} hook copilot ${short}`;
      hooks[event] = [{ type: 'command', bash: cmd, powershell: `& ${cmd}`, timeoutSec: short === 'start' || short === 'end' ? 10 : 5 }];
    }
    const after = `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
    const m = mcpJson(root, '.vscode/mcp.json', 'servers', { type: 'stdio', ...mcpLaunch(root, inv) }, 'Add it in VS Code with "MCP: Add Server".');
    return {
      actions: [{ file: COPILOT_FILE, kind: 'file', before, after }, ...m.actions],
      tier: 'enforced',
      how: 'native hooks (Copilot CLI and VS Code)',
      gitignore: [COPILOT_FILE, ...m.gitignore],
      notes: [...m.notes, `Copilot CLI reads MCP servers from ~/.copilot/mcp-config.json; to use Kerb's there, add "kerb": { "type": "stdio", "command": ${JSON.stringify(mcpLaunch(root, inv).command)}, "args": ${JSON.stringify(mcpLaunch(root, inv).args)} } under "mcpServers".`],
    };
  },
  skillPaths: () => ['.github/skills/kerb/SKILL.md'],
  hookCommands(root) {
    const { obj } = readJsonText(root, COPILOT_FILE);
    const out = {};
    for (const [event, short] of Object.entries(COPILOT_EVENTS)) {
      const e = ((obj.hooks || {})[event] || []).find((h) => typeof h.bash === 'string' && KERB_HOOK('copilot', short).test(h.bash));
      out[event] = e ? e.bash : null;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Cursor: .cursor/hooks.json, flat entries per event.

const CURSOR_FILE = '.cursor/hooks.json';
const CURSOR_EVENTS = { sessionStart: ['start', null], preToolUse: ['pre', 'Shell'], postToolUse: ['post', 'Shell'], postToolUseFailure: ['post-failure', 'Shell'], sessionEnd: ['end', null] };

const cursor = {
  id: 'cursor',
  name: 'Cursor',
  settingsFile: CURSOR_FILE,
  detect(root, home) {
    return exists(path.join(root, '.cursor')) || exists(path.join(home, '.cursor')) || onPath('cursor') || onPath('cursor-agent');
  },
  plan(root, home, inv) {
    const { text, obj } = readJsonText(root, CURSOR_FILE);
    obj.version = obj.version || 1;
    obj.hooks = obj.hooks && typeof obj.hooks === 'object' ? obj.hooks : {};
    for (const [event, [short, matcher]] of Object.entries(CURSOR_EVENTS)) {
      const list = Array.isArray(obj.hooks[event]) ? obj.hooks[event] : [];
      obj.hooks[event] = list;
      const command = `${inv.command} hook cursor ${short}`;
      const entry = list.find((h) => h && typeof h.command === 'string' && KERB_HOOK('cursor', short).test(h.command));
      const fresh = matcher ? { command, matcher, timeout: short === 'start' ? 10 : 5 } : { command, timeout: 10 };
      if (entry) Object.assign(entry, fresh);
      else list.push(fresh);
    }
    const m = mcpJson(root, '.cursor/mcp.json', 'mcpServers', { type: 'stdio', ...mcpLaunch(root, inv) }, 'Add it in Cursor Settings → MCP.');
    return {
      actions: [{ file: CURSOR_FILE, kind: 'json', before: text, after: `${JSON.stringify(obj, null, 2)}\n` }, ...m.actions],
      tier: 'enforced',
      how: 'native hooks',
      gitignore: [...(text === null ? [CURSOR_FILE] : []), ...m.gitignore],
      notes: [...trackedNote(root, CURSOR_FILE, text), ...m.notes],
    };
  },
  strip(obj, isKerb) {
    if (!obj.hooks) return;
    for (const [event, list] of Object.entries(obj.hooks)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((h) => !(h && isKerb(h.command)));
      if (kept.length) obj.hooks[event] = kept;
      else delete obj.hooks[event];
    }
  },
  hookCommands(root) {
    const { obj } = readJsonText(root, CURSOR_FILE);
    const out = {};
    for (const [event, [short]] of Object.entries(CURSOR_EVENTS)) {
      const e = ((obj.hooks || {})[event] || []).find((h) => h && typeof h.command === 'string' && KERB_HOOK('cursor', short).test(h.command));
      out[event] = e ? e.command : null;
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Codex CLI and Gemini CLI: Claude-style settings with their own event names.

function claudeStyleAgent({ id, name, file, events, detect, units = 1, how = 'native hooks', note, extra }) {
  return {
    id,
    name,
    settingsFile: file,
    detect,
    plan(root, home, inv) {
      const { text, obj } = readJsonText(root, file);
      for (const [event, [short, matcher]] of Object.entries(events)) {
        mergeClaudeStyle(obj, event, matcher, `${inv.command} hook ${id} ${short}`, (short === 'start' || short === 'end' ? 10 : 5) * units, KERB_HOOK(id, short));
      }
      const more = extra ? extra(root, inv, obj) : [];
      return {
        actions: [{ file, kind: 'json', before: text, after: `${JSON.stringify(obj, null, 2)}\n` }],
        tier: 'enforced',
        how,
        gitignore: text === null ? [file] : [],
        notes: [...trackedNote(root, file, text), ...(note ? [note] : []), ...more],
      };
    },
      strip: stripClaudeStyle,
    hookCommands(root) {
      const { obj } = readJsonText(root, file);
      return claudeStyleCommands(obj, id, Object.fromEntries(Object.entries(events).map(([e, [s]]) => [e, s])));
    },
  };
}

const codex = claudeStyleAgent({
  id: 'codex',
  name: 'Codex CLI',
  file: '.codex/hooks.json',
  events: { SessionStart: ['start', null], PreToolUse: ['pre', 'Bash'], PostToolUse: ['post', 'Bash'], Stop: ['stop', null], SessionEnd: ['end', null] },
  detect: (root, home) => exists(path.join(root, '.codex')) || exists(path.join(home, '.codex')) || onPath('codex'),
  note: 'Codex runs new hooks only after you trust them: open /hooks in Codex once and trust the Kerb entries.',
  extra: (root, inv) => [`Kerb's MCP server for Codex (optional, read-only): codex mcp add kerb -- ${mcpCommandLine(root, inv)}`],
});

const gemini = claudeStyleAgent({
  id: 'gemini',
  name: 'Gemini CLI',
  file: '.gemini/settings.json',
  events: { SessionStart: ['start', null], BeforeTool: ['pre', 'run_shell_command'], AfterTool: ['post', 'run_shell_command'], AfterAgent: ['stop', null], SessionEnd: ['end', null], PreCompress: ['compact', null], BeforeAgent: ['turn', null] },
  detect: (root, home) => exists(path.join(root, '.gemini')) || exists(path.join(home, '.gemini')) || exists(path.join(root, 'GEMINI.md')) || onPath('gemini'),
  units: 1000,
  note: 'Gemini CLI asks you to trust changed project hooks the first time they run.',
  extra: (root, inv, obj) => {
    obj.mcpServers = obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : {};
    obj.mcpServers.kerb = mcpLaunch(root, inv);
    return [];
  },
});

// ---------------------------------------------------------------------------
// OpenCode: a generated plugin that pipes tool events to kerb hook opencode.

const OPENCODE_FILE = '.opencode/plugins/kerb.js';

const opencode = {
  id: 'opencode',
  name: 'OpenCode',
  settingsFile: OPENCODE_FILE,
  detect(root, home) {
    return exists(path.join(root, '.opencode')) || exists(path.join(root, 'opencode.json')) || exists(path.join(home, '.config', 'opencode')) || onPath('opencode');
  },
  plan(root, home, inv) {
    const before = readText(path.join(root, OPENCODE_FILE));
    const argv = inv.binary ? [inv.binary] : [inv.node, inv.script];
    return {
      actions: [{ file: OPENCODE_FILE, kind: 'file', before, after: pluginSource(argv) }],
      tier: 'enforced',
      how: 'plugin (tool.execute.before/after)',
      gitignore: [OPENCODE_FILE],
      notes: [`Kerb's MCP server for OpenCode (optional, read-only): add "mcp": { "kerb": { "type": "local", "command": ${JSON.stringify([mcpLaunch(root, inv).command, ...mcpLaunch(root, inv).args])}, "enabled": true } } to opencode.json.`],
    };
  },
  hookCommands(root) {
    const t = readText(path.join(root, OPENCODE_FILE));
    const m = t && /const KERB = (\[.*\]);/.exec(t);
    if (!m) return { plugin: null };
    const argv = JSON.parse(m[1]);
    return { plugin: `${argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a}"`)).join(' ')} hook opencode pre` };
  },
};

// Any agent without hooks: the AGENTS.md instructions only.
const other = {
  id: 'other',
  name: 'Any other agent',
  detect: () => false,
  plan: () => ({ actions: [], tier: 'best effort', how: 'AGENTS.md instructions', notes: [] }),
};

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export const AGENT_DESCRIPTORS = [claude, copilot, cursor, codex, gemini, opencode, other];
export { mergeClaudeStyle, stripClaudeStyle, claudeStyleCommands, readJsonText, KERB_HOOK };
