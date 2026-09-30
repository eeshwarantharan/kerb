// Host extraction (4.8.3): explicit URLs and flags, git remotes, curl/wget targets,
// docker image registries, and implicit package registries.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitSub } from './tokenize.js';

/**
 * Programs whose URL arguments mean network access. URLs mentioned to other programs
 * (echo, grep, sed, git commit -m …) are text, not traffic, so they never trigger a refusal.
 */
export const NETWORK_PROGRAMS = new Set([
  'curl', 'wget', 'http', 'https', 'xh', 'aria2c', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'nc', 'ncat', 'telnet',
  'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'pip', 'pip3', 'pipx', 'uv', 'uvx', 'poetry', 'conda', 'mamba',
  'go', 'cargo', 'rustup', 'git', 'gh', 'docker', 'podman', 'nerdctl', 'apt', 'apt-get', 'brew', 'gem', 'bundle',
  'mvn', 'mvnw', 'gradle', 'gradlew', 'dotnet', 'nuget', 'composer', 'deno', 'helm',
]);

// Subcommands that only change local configuration, even when a URL is an argument.
const CONFIG_SUBS = new Set(['config', 'set-url', 'remote']);
const GIT_NETWORK = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote', 'submodule']);

/**
 * Host of a URL or scp-like git address, lower-cased; null if none.
 * @param {string} s
 */
export function hostFromUrl(s) {
  if (!s) return null;
  let m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]*)/i.exec(s);
  if (m) {
    let auth = m[1];
    const at = auth.lastIndexOf('@');
    if (at !== -1) auth = auth.slice(at + 1);
    if (auth.startsWith('[')) {
      const end = auth.indexOf(']');
      return end > 0 ? auth.slice(1, end).toLowerCase() : null;
    }
    const host = auth.split(':')[0].toLowerCase().replace(/\.$/, '');
    return host || null;
  }
  m = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)/.exec(s);
  if (m) return m[1].toLowerCase();
  return null;
}

const URL_IN_TEXT = /\b(?:https?|ssh|git|ftp|wss?|git\+ssh|git\+https|sparse\+https):\/\/[^\s'"<>`]+/gi;
const BARE_HOST = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i;

/** A host from a URL, or from a bare `host.tld[:port][/path]`. */
function hostLoose(s) {
  const h = hostFromUrl(s);
  if (h) return h;
  const m = BARE_HOST.exec(s);
  return m ? m[1].toLowerCase() : null;
}

const HOST_FLAGS = new Set(['--registry', '--index-url', '--extra-index-url', '--index', '--default-index']);
const PIP_LIKE = new Set(['pip', 'pip3', 'uv', 'poetry', 'pipx']);

const CURL_VALUE = new Set(['-o', '-d', '-H', '-X', '-u', '-A', '-e', '-F', '-T', '-x', '-w', '-m', '-b', '-c', '-K', '-r', '-E', '-U', '-y', '-Y', '-z', '-C', '-P', '-Q',
  '--output', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--header', '--request', '--user', '--user-agent',
  '--referer', '--form', '--upload-file', '--proxy', '--write-out', '--max-time', '--cookie', '--cookie-jar', '--config',
  '--range', '--cert', '--key', '--cacert', '--connect-timeout', '--retry', '--resolve', '--output-dir', '--json']);
const WGET_VALUE = new Set(['-O', '-o', '-P', '-U', '-t', '-T', '-e', '-a', '-i', '--header', '--user-agent',
  '--output-document', '--directory-prefix', '--tries', '--timeout', '--output-file', '--input-file']);
const DOCKER_RUN_VALUE = new Set(['-e', '--env', '-v', '--volume', '-p', '--publish', '--name', '-w', '--workdir', '--network', '--net',
  '--env-file', '-u', '--user', '--entrypoint', '-l', '--label', '--mount', '--platform', '-h', '--hostname', '--add-host',
  '--cpus', '-m', '--memory', '--restart', '--log-driver', '--log-opt', '--device', '--cap-add', '--cap-drop', '--dns',
  '--pid', '--ipc', '--tmpfs', '--ulimit', '--security-opt', '--gpus', '--shm-size', '--expose', '--link', '--volumes-from',
  '--health-cmd', '-a', '--attach', '--cidfile', '--stop-signal', '--stop-timeout', '--runtime', '--pull', '--label-file']);

/**
 * @typedef {{ host: string, how: 'url' | 'flag' | 'git-remote' | 'positional' | 'image' | 'implicit', detail?: string }} HostRef
 */

/**
 * Explicit hosts named by one segment.
 * @param {import('./tokenize.js').Segment} seg
 * @param {{ resolveGitRemote?: (dir: string, name: string) => string | null }} [opts]
 * @returns {HostRef[]}
 */
export function explicitHosts(seg, { resolveGitRemote = gitRemoteUrl } = {}) {
  if (seg.opaque || !seg.name || !NETWORK_PROGRAMS.has(seg.name)) return [];
  /** @type {HostRef[]} */
  const out = [];
  const add = (host, how, detail) => { if (host) out.push({ host, how, detail }); };
  const name = seg.name;
  const args = seg.args;
  const sub = args.find((a) => !a.startsWith('-'));

  if (name === 'git') {
    const g = gitSub(seg);
    if (!g || !GIT_NETWORK.has(g.sub)) return [];
    for (const a of g.args) for (const m of a.matchAll(URL_IN_TEXT)) add(hostFromUrl(m[0]), 'url');
    const positional = g.args.filter((a) => !a.startsWith('-'));
    if (g.sub === 'clone') {
      if (positional[0]) add(hostFromUrl(positional[0]), 'url');
    } else if (g.sub !== 'submodule') {
      const first = positional[0];
      if (first && hostFromUrl(first)) add(hostFromUrl(first), 'url');
      else {
        const remote = first || 'origin';
        const url = resolveGitRemote(g.dir, remote);
        if (url) add(hostFromUrl(url), 'git-remote', remote);
      }
    }
    return dedupe(out);
  }
  if (sub && CONFIG_SUBS.has(sub)) return [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const m of a.matchAll(URL_IN_TEXT)) add(hostFromUrl(m[0]), 'url');
    if (!a.startsWith('-')) {
      const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(a) ? hostFromUrl(a) : null;
      if (scp) add(scp, 'url');
      continue;
    }
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const isHostFlag = HOST_FLAGS.has(flag) || (flag === '-i' && PIP_LIKE.has(name));
    if (isHostFlag) {
      const value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
      if (value) add(hostLoose(value), 'flag', flag);
    }
  }

  if (name === 'curl' || name === 'wget') {
    const valued = name === 'curl' ? CURL_VALUE : WGET_VALUE;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--url') { add(hostLoose(args[i + 1] || ''), 'positional'); i++; continue; }
      if (a.startsWith('-')) {
        if (!a.includes('=') && valued.has(a)) i++;
        continue;
      }
      add(hostLoose(a), 'positional');
    }
  }

  if (name === 'docker' || name === 'podman' || name === 'nerdctl') {
    const idx = args.findIndex((a) => !a.startsWith('-'));
    const verb = args[idx];
    if (verb === 'pull' || verb === 'run' || verb === 'create') {
      const rest = args.slice(idx + 1);
      let image = null;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a.startsWith('-')) {
          if (!a.includes('=') && (DOCKER_RUN_VALUE.has(a) || (verb === 'pull' && a === '--platform'))) i++;
          continue;
        }
        image = a;
        break;
      }
      if (image) add(imageRegistry(image), 'image', image);
    }
  }
  return dedupe(out);
}

/** Registry host of a container image reference (Docker's rules). */
export function imageRegistry(image) {
  const first = image.split('/')[0];
  if (image.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    return first.split(':')[0].toLowerCase();
  }
  return 'docker.io';
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((h) => (seen.has(h.host) ? false : (seen.add(h.host), true)));
}

/** URL of a git remote via `git remote get-url` (respects insteadOf); null on failure. */
export function gitRemoteUrl(dir, name) {
  try {
    const r = spawnSync('git', ['-C', dir, 'remote', 'get-url', name], { encoding: 'utf8', timeout: 500 });
    return r.status === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Implicit registries

const NPM_VERBS = new Set(['install', 'i', 'add', 'ci', 'update']);

/**
 * Hosts a package-manager segment will contact without naming them.
 * Returns [] when the registry can't be determined (unknown means allow).
 * @param {import('./tokenize.js').Segment} seg
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [opts]
 * @returns {HostRef[]}
 */
export function implicitHosts(seg, { env = process.env, home = os.homedir() } = {}) {
  if (seg.opaque || !seg.name) return [];
  const { name, args } = seg;
  const verb = args.find((a) => !a.startsWith('-'));
  const hasFlag = (...f) => args.some((a) => f.includes(a.split('=')[0]));
  const one = (host, detail) => (host ? [{ host, how: /** @type {const} */ ('implicit'), detail }] : []);

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name) && NPM_VERBS.has(verb)) {
    if (hasFlag('--registry', '--offline')) return [];
    const reg = npmRegistry(name, seg.cwd, env, home);
    return reg === undefined ? [] : one(hostFromUrl(reg) || hostLoose(reg), `${name} registry`);
  }

  const pipInstall = ((name === 'pip' || name === 'pip3') && verb === 'install')
    || (/^python[0-9.]*$/.test(name) && args[0] === '-m' && args[1] === 'pip' && args.slice(2).find((a) => !a.startsWith('-')) === 'install');
  if (pipInstall) {
    if (hasFlag('-i', '--index-url', '--no-index')) return [];
    const idx = pipIndex(env, home);
    return idx === undefined ? [] : one(hostLoose(idx), 'pip index');
  }
  const uvInstall = name === 'uv' && ((verb === 'pip' && args[args.indexOf('pip') + 1] === 'install') || verb === 'add');
  if (uvInstall) {
    if (hasFlag('-i', '--index-url', '--index', '--default-index', '--offline', '--no-index')) return [];
    const idx = uvIndex(seg.cwd, env, home);
    return idx === undefined ? [] : one(hostLoose(idx), 'uv index');
  }

  if (name === 'go' && (verb === 'get' || (verb === 'mod' && args[args.indexOf('mod') + 1] === 'download'))) {
    const proxy = env.GOPROXY ?? goEnvFile(env, home).GOPROXY ?? 'https://proxy.golang.org,direct';
    return proxy.split(/[,|]/).map((p) => p.trim()).filter((p) => p && p !== 'direct' && p !== 'off')
      .flatMap((p) => one(hostLoose(p), 'GOPROXY'));
  }

  if (name === 'cargo' && (verb === 'add' || verb === 'fetch')) {
    if (hasFlag('--offline', '--frozen') || /^(true|1)$/i.test(env.CARGO_NET_OFFLINE || '')) return [];
    const reg = cargoRegistry(seg.cwd, home);
    return reg === undefined ? [] : one(hostLoose(reg), 'cargo registry');
  }
  return [];
}

/** Walk from dir to the filesystem root, returning the first value `read` finds. */
function upward(dir, read) {
  let d = dir;
  for (;;) {
    const v = read(d);
    if (v !== undefined) return v;
    const parent = path.dirname(d);
    if (parent === d) return undefined;
    d = parent;
  }
}

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** Expand ${VAR} from env; undefined if a variable is missing (unknown registry). */
function expandEnv(s, env) {
  let missing = false;
  const out = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => {
    if (env[k] == null) missing = true;
    return env[k] ?? '';
  });
  return missing ? undefined : out;
}

function npmrcRegistry(file, env) {
  const text = readText(file);
  if (text == null) return undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*registry\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return expandEnv(m[1].replace(/^["']|["']$/g, ''), env) ?? null;
  }
  return undefined;
}

/**
 * The default registry for an npm-family tool. undefined = can't tell (allow);
 * npm precedence: environment, project .npmrc (cwd upward), ~/.npmrc, default.
 */
function npmRegistry(tool, cwd, env, home) {
  const fromEnv = env.npm_config_registry || env.NPM_CONFIG_REGISTRY;
  if (tool === 'yarn') {
    const y = env.YARN_NPM_REGISTRY_SERVER || env.YARN_REGISTRY;
    if (y) return y;
    const berry = upward(cwd, (d) => {
      const t = readText(path.join(d, '.yarnrc.yml'));
      if (t == null) return undefined;
      const m = /^\s*npmRegistryServer\s*:\s*["']?([^"'\s]+)["']?\s*$/m.exec(t);
      return m ? m[1] : undefined;
    });
    if (berry !== undefined) return berry;
    const v1 = upward(cwd, (d) => {
      const t = readText(path.join(d, '.yarnrc'));
      if (t == null) return undefined;
      const m = /^\s*registry\s+["']?([^"'\s]+)["']?\s*$/m.exec(t);
      return m ? m[1] : undefined;
    });
    if (v1 !== undefined) return v1;
  }
  if (tool === 'bun') {
    const b = upward(cwd, (d) => {
      const t = readText(path.join(d, 'bunfig.toml'));
      if (t == null) return undefined;
      const m = /^\s*registry\s*=\s*"([^"]+)"/m.exec(t);
      return m ? m[1] : undefined;
    });
    if (b !== undefined) return b;
  }
  if (fromEnv) return fromEnv;
  const project = upward(cwd, (d) => (d === home ? undefined : npmrcRegistry(path.join(d, '.npmrc'), env)));
  if (project !== undefined) return project ?? undefined;
  const user = npmrcRegistry(path.join(home, '.npmrc'), env);
  if (user !== undefined) return user ?? undefined;
  return 'https://registry.npmjs.org/';
}

function iniValue(text, keys) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_-]+)\s*[=:]\s*(\S+)/.exec(line);
    if (m && keys.includes(m[1].toLowerCase())) return m[2];
  }
  return undefined;
}

/** pip's index URL: PIP_INDEX_URL, then pip.conf (site, user, global), else pypi.org. */
function pipIndex(env, home) {
  if (env.PIP_INDEX_URL) return env.PIP_INDEX_URL;
  const files = [
    env.PIP_CONFIG_FILE,
    env.VIRTUAL_ENV && path.join(env.VIRTUAL_ENV, process.platform === 'win32' ? 'pip.ini' : 'pip.conf'),
    env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, 'pip', 'pip.conf'),
    path.join(home, '.config', 'pip', 'pip.conf'),
    path.join(home, '.pip', 'pip.conf'),
    path.join(home, 'Library', 'Application Support', 'pip', 'pip.conf'),
    env.APPDATA && path.join(env.APPDATA, 'pip', 'pip.ini'),
    '/etc/xdg/pip/pip.conf',
    '/etc/pip.conf',
  ].filter(Boolean);
  for (const f of files) {
    const t = readText(f);
    if (t == null) continue;
    const v = iniValue(t, ['index-url', 'index_url']);
    if (v) return v;
  }
  return 'https://pypi.org/simple';
}

/** uv's default index: env, then uv.toml / pyproject.toml; undefined when configured but unclear. */
function uvIndex(cwd, env, home) {
  const e = env.UV_DEFAULT_INDEX || env.UV_INDEX_URL;
  if (e) return e;
  const fromFile = (t) => {
    if (t == null) return undefined;
    const direct = /^\s*index-url\s*=\s*"([^"]+)"/m.exec(t);
    if (direct) return direct[1];
    const blocks = t.split(/^\s*\[\[(?:tool\.uv\.)?index\]\]\s*$/m).slice(1);
    for (const b of blocks) {
      const body = b.split(/^\s*\[/m)[0];
      if (/^\s*default\s*=\s*true/m.test(body)) {
        const u = /^\s*url\s*=\s*"([^"]+)"/m.exec(body);
        return u ? u[1] : null;
      }
    }
    return blocks.length ? undefined : undefined;
  };
  const found = upward(cwd, (d) => {
    const v = fromFile(readText(path.join(d, 'uv.toml')));
    if (v !== undefined) return v;
    const py = readText(path.join(d, 'pyproject.toml'));
    return py && /\[tool\.uv/.test(py) ? fromFile(py) : undefined;
  });
  if (found !== undefined) return found ?? undefined;
  const user = fromFile(readText(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'uv', 'uv.toml')));
  if (user !== undefined) return user ?? undefined;
  return 'https://pypi.org/simple';
}

/** Parse Go's env file (GOENV) into key/value pairs. */
function goEnvFile(env, home) {
  let file = env.GOENV;
  if (!file) {
    if (process.platform === 'darwin') file = path.join(home, 'Library', 'Application Support', 'go', 'env');
    else if (process.platform === 'win32') file = env.APPDATA && path.join(env.APPDATA, 'go', 'env');
    else file = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'go', 'env');
  }
  const t = file ? readText(file) : null;
  /** @type {Record<string, string>} */
  const out = {};
  if (!t) return out;
  for (const line of t.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** crates.io, or the source that replaces it in .cargo/config(.toml); undefined if unclear. */
function cargoRegistry(cwd, home) {
  const check = (dir) => {
    for (const f of ['config.toml', 'config']) {
      const t = readText(path.join(dir, '.cargo', f));
      if (t == null) continue;
      const rep = /\[source\.crates-io\][^[]*?replace-with\s*=\s*"([^"]+)"/m.exec(t);
      if (!rep) continue;
      const src = new RegExp(`\\[source\\.${rep[1].replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}\\][^[]*?(?:registry|local-registry|directory)\\s*=\\s*"([^"]+)"`, 'm').exec(t);
      if (!src) return null;
      return /^(sparse\+)?[a-z]+:\/\//.test(src[1]) ? src[1].replace(/^sparse\+/, '') : null;
    }
    return undefined;
  };
  const found = upward(cwd, check);
  if (found !== undefined) return found ?? undefined;
  const user = check(home);
  if (user !== undefined) return user ?? undefined;
  return 'https://crates.io';
}

/**
 * All hosts a parsed command would contact (explicit and implicit), with the segment index.
 * @param {import('./tokenize.js').Parsed} parsed
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, resolveGitRemote?: (dir: string, name: string) => string | null }} [opts]
 * @returns {(HostRef & { segment: number })[]}
 */
export function commandHosts(parsed, opts = {}) {
  const out = [];
  parsed.segments.forEach((seg, i) => {
    for (const h of explicitHosts(seg, opts)) out.push({ ...h, segment: i });
    for (const h of implicitHosts(seg, opts)) out.push({ ...h, segment: i });
  });
  return out;
}
