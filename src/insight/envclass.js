// Environment classifier (KERB-V2 8.3). A failure caused by the environment (TLS interception,
// a corporate proxy's block page, expired credentials) is not the agent's code going wrong:
// it is recorded as failure_kind "environment" with a subtype, never counts toward loops, and
// carries one fix line. Kerb never suggests turning certificate verification off.

/** TLS interception: a proxy re-signs HTTPS with a company CA the tool doesn't trust. */
const TLS = [
  { re: /SELF_SIGNED_CERT_IN_CHAIN/, tool: 'node' },
  { re: /UNABLE_TO_GET_ISSUER_CERT_LOCALLY/, tool: 'node' },
  { re: /UNABLE_TO_VERIFY_LEAF_SIGNATURE/, tool: 'node' },
  { re: /self[- ]signed certificate in certificate chain/i, tool: null },
  { re: /unable to get local issuer certificate/i, tool: null },
  { re: /CERTIFICATE_VERIFY_FAILED/, tool: 'python' },
  { re: /PKIX path building failed/, tool: 'java' },
  { re: /x509: certificate signed by unknown authority/, tool: 'go' },
];

/**
 * Corporate proxy block pages. Added only from real captures, each with a fixture in
 * test/fixtures/env/proxy/ (EN6). Squid's text is its stock ERR_ACCESS_DENIED template.
 */
export const PROXY_PAGES = [
  { id: 'squid-access-denied', re: /Access control configuration prevents your request from being allowed at this time/i, vendor: 'Squid' },
];

/** Expired credentials: a 401 with an expiry message, gh auth errors, cloud ExpiredToken. */
const AUTH = [
  /\bExpiredToken(?:Exception)?\b/,
  /security token included in the request is expired/i,
  /\b401\b.*\b(?:token|credentials?|session)\b.*\bexpired\b/i,
  /\b(?:token|credentials?|session)\b.*\bexpired\b.*\b401\b/i,
  /\bgh auth login\b/,
  /\bgh: HTTP 401\b|\bHTTP 401: Bad credentials\b/,
  /The refresh token has expired|AADSTS700082/,
  /Reauthentication (?:is )?required|reauthentication failed/i,
];

const MAX_LINE = 4096;

/** Streaming detection over output lines; first match wins, in subtype order. */
export class EnvClassifier {
  constructor() {
    /** @type {{ subtype: string, line: string, tool?: string | null, signature?: string } | null} */
    this.found = null;
    this.tls = null;
    this.proxy = null;
    this.auth = null;
  }

  /** @param {string} line ANSI-stripped, redacted */
  line(line) {
    if (line.length > MAX_LINE || (this.tls && this.proxy && this.auth)) return;
    if (!this.tls) {
      const m = TLS.find((s) => s.re.test(line));
      if (m) this.tls = { subtype: 'tls_interception', line: line.trim(), tool: m.tool };
    }
    if (!this.proxy) {
      const m = PROXY_PAGES.find((s) => s.re.test(line));
      if (m) this.proxy = { subtype: 'proxy_page', line: line.trim(), signature: m.id };
    }
    if (!this.auth && AUTH.some((re) => re.test(line))) this.auth = { subtype: 'auth_expired', line: line.trim() };
  }

  result() {
    return this.tls || this.proxy || this.auth || null;
  }
}

export function classifyEnvironment(text) {
  const c = new EnvClassifier();
  for (const l of String(text).split('\n')) c.line(l);
  return c.result();
}

// Which tool the fix is for: the command's programs first, then the signature's hint.
const TOOLS = [
  { tool: 'bun', programs: ['bun', 'bunx'] },
  { tool: 'npm', programs: ['npm', 'npx'] },
  { tool: 'node', programs: ['node', 'yarn', 'pnpm', 'pnpx', 'corepack', 'tsx', 'ts-node', 'deno'] },
  { tool: 'uv', programs: ['uv', 'uvx'] },
  { tool: 'pip', programs: ['pip', 'pip3', 'pipx'] },
  { tool: 'python', programs: ['python', 'python3', 'poetry', 'pipenv', 'pytest'] },
  { tool: 'curl', programs: ['curl', 'wget', 'openssl', 'http', 'https'] },
  { tool: 'git', programs: ['git', 'gh'] },
  { tool: 'aws', programs: ['aws', 'sam', 'cdk'] },
  { tool: 'go', programs: ['go', 'terraform', 'kubectl', 'helm'] },
  { tool: 'java', programs: ['java', 'javac', 'mvn', 'mvnw', './mvnw', 'gradle', 'gradlew', './gradlew', 'sbt', 'kotlin'] },
];

/**
 * @param {string[]} programs the command's segment programs, in order
 * @param {string | null} hint the matching signature's tool, if any
 */
export function toolFor(programs, hint = null) {
  for (const p of programs) {
    const base = String(p).split('/').pop();
    const t = TOOLS.find((x) => x.programs.includes(p) || x.programs.includes(base));
    if (t) return t.tool;
  }
  return hint;
}

/**
 * The per-tool setting that points a tool at the company CA bundle (8.3). Never a setting that
 * turns verification off.
 * @param {string | null} tool
 * @param {string} bundle absolute path
 * @param {{ args?: string[] }} [o] the first segment's args, to tell `bun install` from `bun run`
 */
export function tlsSetting(tool, bundle, o = {}) {
  const sub = (o.args || [])[0];
  switch (tool) {
    case 'npm': return `NODE_EXTRA_CA_CERTS=${bundle} for this command, and \`npm config set cafile ${bundle}\` for npm's own requests`;
    case 'node': return `NODE_EXTRA_CA_CERTS=${bundle} for this command`;
    case 'bun':
      return ['install', 'i', 'add', 'update', 'pm', 'remove', 'outdated'].includes(sub)
        ? `cafile = "${bundle}" under [install] in bunfig.toml`
        : `NODE_EXTRA_CA_CERTS=${bundle} for this command`;
    case 'pip': return `PIP_CERT=${bundle} for this command`;
    case 'python': return `REQUESTS_CA_BUNDLE=${bundle} (and PIP_CERT=${bundle} for pip) for this command`;
    case 'uv': return `SSL_CERT_FILE=${bundle} for this command`;
    case 'curl': return `SSL_CERT_FILE=${bundle} (curl also reads CURL_CA_BUNDLE=${bundle}) for this command`;
    case 'git': return `GIT_SSL_CAINFO=${bundle} for this command`;
    case 'aws': return `AWS_CA_BUNDLE=${bundle} for this command`;
    case 'go': return `SSL_CERT_FILE=${bundle} for this command`;
    case 'java': return null;
    default: return `the tool's CA-bundle setting pointed at ${bundle} (for OpenSSL-based tools, SSL_CERT_FILE=${bundle})`;
  }
}

/**
 * The company CA bundle: the managed config (`tls.ca_bundle`), then the org bundle, then the
 * user config. Never the repo policy.
 * @param {{ values: any, managed: any }} config
 * @param {{ tls_ca_bundle?: { path: string, source: string } | null }} policy
 * @returns {{ path: string, source: string } | null}
 */
export function caBundleFor(config, policy) {
  const m = config && config.managed;
  const managed = m && ((m.tls && m.tls.ca_bundle) || (m.defaults && m.defaults['tls.ca_bundle']));
  if (typeof managed === 'string' && managed) return { path: managed, source: "your organisation's managed config" };
  if (policy && policy.tls_ca_bundle) return policy.tls_ca_bundle;
  const user = config && config.values && config.values['tls.ca_bundle'];
  if (typeof user === 'string' && user) return { path: user, source: 'your Kerb config' };
  return null;
}

/**
 * Fix lines for an environment failure of this command, or [].
 * @param {any} prep engine prep (parsed, config, policy)
 * @param {any} env Analyzer result `env`
 */
export function envFixFor(prep, env) {
  if (!env) return [];
  const segs = prep.parsed.segments.filter((s) => s.name && !['cd', 'pushd', 'popd'].includes(s.name));
  const sanctioned = (prep.policy.environment_fixes || {})[env.subtype] || null;
  return envFixLines(env, { programs: segs.map((s) => s.name), args: segs[0] ? segs[0].args : [], caBundle: caBundleFor(prep.config, prep.policy), sanctioned });
}

const SUMMARY = {
  tls_interception: 'TLS interception: a proxy re-signs HTTPS with a company CA this tool does not trust; not a code problem',
  proxy_page: 'the corporate proxy answered with a block page; not a code problem',
  auth_expired: 'credentials expired; not a code problem',
};

/**
 * The two-line fix block for an environment failure.
 * @param {{ subtype: string, tool?: string | null }} env
 * @param {{ programs?: string[], args?: string[], caBundle?: { path: string, source: string } | null,
 *   sanctioned?: { text: string, source: string } | null }} o
 * @returns {string[]}
 */
export function envFixLines(env, o = {}) {
  const head = `kerb: environment · ${SUMMARY[env.subtype] || env.subtype}`;
  // A configured CA bundle gives the precise per-tool fix; otherwise a sanctioned fix from policy.
  const sanctioned = o.sanctioned && !(env.subtype === 'tls_interception' && o.caBundle) ? o.sanctioned : null;
  if (sanctioned) return [head, `      next: ${sanctioned.text} (from ${sanctioned.source})`];
  if (env.subtype === 'proxy_page') return [head, '      next: Blocked by the corporate proxy; tell the user which URL you need'];
  if (env.subtype === 'auth_expired') return [head, '      next: Credentials expired; ask the user to re-authenticate'];
  const tool = toolFor(o.programs || [], env.tool || null);
  if (!o.caBundle) {
    return [head, "      next: TLS interception detected; the company CA isn't configured for this tool. Ask the user, or run `kerb doctor tls`"];
  }
  const setting = tlsSetting(tool, o.caBundle.path, { args: o.args });
  if (!setting) {
    return [head, `      next: Java needs the company CA (${o.caBundle.path}) imported into its truststore with keytool, which needs the truststore password; tell the user`];
  }
  return [head, `      next: retry with ${setting} (company CA bundle from ${o.caBundle.source})`];
}
