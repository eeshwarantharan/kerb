// `kerb mcp`: a minimal MCP server over stdio (KERB-V2 11.2): JSON-RPC 2.0, one message per
// line, no dependencies, read-only tools only. MCP is the pull channel; hooks stay the push
// channel and the enforcement.
//
// Protocol (VERIFIED 2026-10-02, decisions log): the current revision, 2026-07-28, is stateless:
// each request carries `_meta["io.modelcontextprotocol/protocolVersion"]` and
// `["io.modelcontextprotocol/clientCapabilities"]`, servers answer `server/discover`, and results
// carry `resultType`. Earlier revisions (2025-11-25 and before) start with `initialize`. Kerb
// serves both: an `initialize` handshake negotiates a legacy version; a request with the modern
// `_meta` is answered statelessly.
import { VERSION } from '../version.js';
import { formatDuration } from '../util/core.js';
import { openQuery } from './query.js';
import { findingLines } from '../insight/triggers.js';
import { series } from '../insight/converge.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_TEXT = 2048;
const META = 'io.modelcontextprotocol/';
const SERVER_INFO = { name: 'kerb', title: 'Kerb', version: VERSION };
const INSTRUCTIONS = 'Kerb records what actually ran in this repo: check runs, test results, kept states, proven fixes and cause findings. These tools only read those records. Ask verification_status before saying tests pass; attempts and progress before retrying a failing check; known_fixes and cause when a failure looks familiar.';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const str = (description) => ({ type: 'string', description });

/** The tools, all read-only (11.2). */
export const TOOLS = [
  { name: 'verification_status', title: 'Verification status', description: 'For each check key in this session: green, red, stale (files changed since it ran, with the files) or never. Ask before claiming tests pass.', inputSchema: obj() },
  { name: 'progress', title: 'Progress', description: 'Failing counts per check key since its last success, and the signal: green, converging, stalled, diverging or oscillating.', inputSchema: obj({ key: str('a check key, or its command') }) },
  { name: 'attempts', title: 'Attempt ledger', description: 'What was tried in the last 24 hours: attempts, failing counts, files edited between attempts, returns to earlier files, last green.', inputSchema: obj({ key: str('a check key, or its command') }) },
  { name: 'test_history', title: 'Test history', description: 'One test\'s recent results (newest first), and whether it is flaky.', inputSchema: obj({ test_id: str('a test id, or the test\'s name') }, ['test_id']) },
  { name: 'known_fixes', title: 'Known fixes', description: 'Proven fixes for a failure fingerprint or a test: when, where, how big. Read the diff with kerb show fix:<id>.', inputSchema: obj({ fingerprint: str('a failure or family fingerprint'), test_id: str('a test id, or the test\'s name') }) },
  { name: 'last_green', title: 'Last green', description: 'The newest kept state where a check (or one test) passed, and how to get a patch back to it.', inputSchema: obj({ key: str('a check key, or its command'), test_id: str('a test id, or the test\'s name') }) },
  { name: 'cause', title: 'Cause', description: 'The cause finding for a test that broke: the culprit hunks, confirmed by probes, or why it could not be isolated.', inputSchema: obj({ test_id: str('a test id, or the test\'s name') }, ['test_id']) },
  { name: 'boundaries', title: 'Boundaries', description: 'Hosts and commands this environment blocks, where each rule comes from, and the alternative to use.', inputSchema: obj() },
  { name: 'explain', title: 'Explain', description: 'Why Kerb refused a command (by refusal or run id), or a run\'s failing tests.', inputSchema: obj({ run_id: str('a run id or refusal id (a prefix works)') }, ['run_id']) },
].map((t) => ({ ...t, annotations: READ_ONLY }));

class ProtocolError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

/** A problem with a tool's arguments: a tool result with isError, so the model can correct it. */
class ToolError extends Error {}

const day = (ts) => (ts ? `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')}` : '?');

/** Cut lines to fit MAX_TEXT bytes, ending with a pointer when anything was cut. */
function fitText(lines, more) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const tail = `… ${lines.length - i} more${more ? `: ${more}` : ''}`;
    const next = [...out, lines[i]].join('\n');
    if (Buffer.byteLength(next) > MAX_TEXT - (i < lines.length - 1 ? Buffer.byteLength(tail) + 1 : 0)) { out.push(tail); break; }
    out.push(lines[i]);
  }
  const text = out.join('\n');
  return Buffer.byteLength(text) <= MAX_TEXT ? text : Buffer.from(text).subarray(0, MAX_TEXT - 3).toString('utf8').replace(/�*$/, '') + '…';
}

/** Trim the longest array in a result until its JSON fits MAX_TEXT; marks `truncated`. */
export function fitStructured(value) {
  const v = JSON.parse(JSON.stringify(value));
  const size = () => Buffer.byteLength(JSON.stringify(v));
  const arrays = (o, acc = []) => {
    if (Array.isArray(o)) { acc.push(o); o.forEach((x) => arrays(x, acc)); } else if (o && typeof o === 'object') Object.values(o).forEach((x) => arrays(x, acc));
    return acc;
  };
  let guard = 0;
  while (size() > MAX_TEXT && guard++ < 10_000) {
    const longest = arrays(v).filter((a) => a.length).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest) break;
    longest.pop();
    v.truncated = true;
  }
  if (size() > MAX_TEXT) return { query: v.query, truncated: true };
  return v;
}

/** Each tool: arguments → { text lines, more pointer, structured result }. */
function runTool(q, name, a) {
  switch (name) {
    case 'verification_status': {
      const r = q.verification();
      const lines = r.keys.map((k) => `${k.command}: ${k.status}${k.files.length ? ` (changed: ${k.files.join(', ')})` : ''}${k.run ? ` · last run ${k.run}` : ''}${k.last_green ? ` · last green ${k.last_green.run}` : ''}`);
      return { lines: lines.length ? lines : ['no check keys tracked in this session yet'], more: 'kerb query verification', result: r };
    }
    case 'progress': {
      const r = q.progress({ key: a.key });
      const lines = r.keys.map((k) => `${k.command}: ${series(k.counts)}${k.signal ? ` (${k.signal})` : ''} · runs ${k.runs.slice(-3).join(', ')}`);
      return { lines: lines.length ? lines : ['no check runs in the last 24 hours'], more: 'kerb query progress', result: r };
    }
    case 'attempts': {
      const r = q.attempts({ key: a.key });
      return { lines: r.text ? r.text.split('\n') : ['no check runs in the last 24 hours'], more: 'kerb ledger', result: r };
    }
    case 'test_history': {
      const r = q.testHistory(a.test_id);
      const lines = r.results.length
        ? [`${r.test_id}${r.flaky ? ' (flaky: it both passed and failed on the same files)' : ''}`, ...r.results.map((t) => `  ${day(t.ts)}  ${t.status.padEnd(5)} run ${t.run}${t.state ? ` · ${t.state}` : ''}${t.message ? ` · ${t.message}` : ''}`)]
        : [`no results for ${a.test_id}`];
      return { lines, more: `kerb query tests --test '${a.test_id}'`, result: r };
    }
    case 'known_fixes': {
      if (!a.fingerprint && !a.test_id) throw new ToolError('give fingerprint or test_id');
      const r = q.fixes({ fingerprint: a.fingerprint, test: a.test_id });
      const lines = r.fixes.map((f) => {
        const where = f.shared ? `shared, commit ${String(f.commit || '').slice(0, 7)}` : f.hunks ? `${f.hunks.length} hunk(s): ${f.hunks.map((h) => h.location).join(', ')}` : `${(f.files || []).length} file(s): ${(f.files || []).slice(0, 3).join(', ')}`;
        return `fix:${f.id.slice(0, 6)} · ${day(f.ts)} · ${where} · ${f.confidence} · tests: ${(f.test_ids || []).slice(0, 2).join(', ') || 'none'} · kerb show fix:${f.id.slice(0, 6)}`;
      });
      return { lines: lines.length ? lines : ['no known fix for that'], more: 'kerb query fixes', result: r };
    }
    case 'last_green': {
      const r = q.lastGreen({ key: a.key, test: a.test_id });
      const g = r.green;
      const lines = g
        ? [`${g.test || g.key}: passed at ${day(g.ts)} (run ${g.run}) · ${g.state}`, g.materializable ? `patch back to it: kerb restore ${g.state} --patch (applies nothing)` : 'that state is not materializable']
        : ['no kept state where it passed'];
      return { lines, more: 'kerb green', result: r };
    }
    case 'cause': {
      const r = q.findings({ test: a.test_id, limit: 3 });
      const lines = r.findings.length ? findingLines(r.findings[0]).map((l) => l.trim()) : [`no cause finding for ${a.test_id}`];
      if (r.findings.length > 1) lines.push(`older findings: ${r.findings.slice(1).map((f) => `f:${f.id.slice(0, 6)}`).join(', ')} (kerb show f:<id>)`);
      return { lines, more: 'kerb query findings', result: r };
    }
    case 'boundaries': {
      const r = q.boundaries();
      const lines = [...r.boundaries.map((b) => `${b.kind} ${b.pattern} · ${b.source}${b.alternative ? ` · use ${b.alternative}` : ''}`), ...r.suspected.map((s) => `host ${s.pattern} · suspected (never blocks)`)];
      return { lines: lines.length ? lines : ['no boundaries known here'], more: 'kerb map', result: r };
    }
    case 'explain': {
      const r = q.explain(a.run_id);
      let lines;
      if (r.refusal) {
        const f = r.refusal;
        lines = [`${f.type === 'would_refuse' ? 'would refuse (shadow mode; it ran)' : 'refused'} ${f.reason} at ${day(f.ts)} · ${f.cmd || f.key}`, f.summary, f.evidence && `evidence: ${f.evidence}`, f.matched_run && `matched run: ${f.matched_run}`, f.next && `next: ${f.next}`].filter(Boolean);
      } else if (r.run) {
        const x = r.run;
        lines = [`run ${x.id} · ${x.cmd} · exit ${x.exit ?? '?'}${x.duration_ms != null ? ` · ${formatDuration(x.duration_ms)}` : ''}${x.framework ? ` · ${x.framework}` : ''}`,
          ...(x.first_fail_line && !r.failing.length ? [`first failing line: ${x.first_fail_line}`] : []),
          ...r.failing.map((t) => `${t.status} ${t.test_id}${t.location ? ` · ${t.location}` : ''}${t.message ? ` · ${t.message}` : ''}`)];
      } else lines = [`no refusal or run ${a.run_id}`];
      return { lines, more: `kerb why ${a.run_id}`, result: r };
    }
    default:
      throw new ProtocolError(-32602, `Unknown tool: ${name}`);
  }
}


/** Check arguments against a tool's input schema (types, required, no unknown fields). */
function checkArgs(tool, args) {
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolError('arguments must be an object');
  const props = tool.inputSchema.properties || {};
  for (const k of Object.keys(args)) {
    if (!props[k]) throw new ToolError(`unknown argument ${k}${Object.keys(props).length ? ` (takes ${Object.keys(props).join(', ')})` : ' (takes none)'}`);
    if (typeof args[k] !== 'string' || !args[k]) throw new ToolError(`${k} must be a non-empty string`);
  }
  for (const k of tool.inputSchema.required || []) if (!args[k]) throw new ToolError(`${k} is required`);
  return args;
}

/**
 * A server for one repo. `handle(message)` returns the response object (or null for a
 * notification); `serve(input, output)` speaks newline-delimited JSON-RPC.
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv }} o
 */
export function createServer(o) {
  let legacyVersion = null;

  function call(params) {
    const p = params || {};
    const tool = TOOLS.find((t) => t.name === p.name);
    if (!tool) throw new ProtocolError(-32602, `Unknown tool: ${p.name}`);
    try {
      const args = checkArgs(tool, p.arguments);
      const q = openQuery({ cwd: o.cwd, env: o.env });
      const r = runTool(q, tool.name, args);
      return { content: [{ type: 'text', text: fitText(r.lines, r.more) }], structuredContent: fitStructured(r.result), isError: false };
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      return { content: [{ type: 'text', text: fitText([`kerb: ${e && e.message ? e.message : e}`]) }], isError: true };
    }
  }

  /** The modern revision: validate `_meta`, else null for a legacy request. */
  function modern(params) {
    const meta = params && params._meta;
    if (!meta || !(`${META}protocolVersion` in meta)) return null;
    const requested = meta[`${META}protocolVersion`];
    if (!MODERN_VERSIONS.includes(requested)) throw new ProtocolError(-32022, 'Unsupported protocol version', { supported: MODERN_VERSIONS, requested });
    if (!meta[`${META}clientCapabilities`] || typeof meta[`${META}clientCapabilities`] !== 'object') throw new ProtocolError(-32602, `missing _meta["${META}clientCapabilities"]`);
    return requested;
  }

  function result(method, params) {
    const isModern = modern(params);
    const wrap = (r) => (isModern ? { resultType: 'complete', ...r, _meta: { ...(r._meta || {}), [`${META}serverInfo`]: SERVER_INFO } } : r);
    switch (method) {
      case 'initialize': {
        const want = params && params.protocolVersion;
        legacyVersion = LEGACY_VERSIONS.includes(want) ? want : LEGACY_VERSIONS[0];
        return { protocolVersion: legacyVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
      }
      case 'server/discover':
        return { resultType: 'complete', supportedVersions: MODERN_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, _meta: { [`${META}serverInfo`]: SERVER_INFO } };
      case 'ping':
        return wrap({});
      case 'tools/list':
        return wrap({ tools: TOOLS });
      case 'tools/call':
        return wrap(call(params));
      default:
        throw new ProtocolError(-32601, `Method not found: ${method}`);
    }
  }

  function handle(msg) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      if (msg && typeof msg === 'object' && !Array.isArray(msg) && ('result' in msg || 'error' in msg)) return null; // a response to us: we send no requests
      return { jsonrpc: '2.0', id: msg && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null, error: { code: -32600, message: 'Invalid Request' } };
    }
    const isNotification = !('id' in msg);
    if (isNotification) return null; // notifications/initialized, cancelled, …: nothing to answer
    try {
      return { jsonrpc: '2.0', id: msg.id, result: result(msg.method, msg.params) };
    } catch (e) {
      const err = e instanceof ProtocolError ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } : { code: -32603, message: `Internal error: ${e && e.message ? e.message : e}` };
      return { jsonrpc: '2.0', id: msg.id, error: err };
    }
  }

  /** One line in, zero or one line out. */
  function line(text) {
    if (!text.trim()) return null;
    let msg;
    try { msg = JSON.parse(text); } catch { return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }; }
    if (Array.isArray(msg)) { // JSON-RPC batches (2025-03-26)
      const out = msg.map(handle).filter(Boolean);
      return out.length ? out : null;
    }
    return handle(msg);
  }

  /** Serve until the input ends. */
  function serve(input, output) {
    return new Promise((resolve) => {
      let buf = '';
      input.setEncoding('utf8');
      input.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
          const r = line(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (r) output.write(`${JSON.stringify(r)}\n`);
        }
      });
      input.on('end', () => {
        const r = line(buf);
        if (r) output.write(`${JSON.stringify(r)}\n`);
        resolve();
      });
      input.on('error', () => resolve());
    });
  }

  return { handle, line, serve, get version() { return legacyVersion; } };
}
