// Boundary pre-check (4.8.3): hosts, implicit registries, programs, commands, git push.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EXIT, globToRegExp } from '../util/core.js';
import { gitSub } from '../parse/tokenize.js';
import { explicitHosts, implicitHosts, gitRemoteUrl } from '../parse/hosts.js';

/**
 * Host glob: `*` matches one or more labels at that position; other labels match exactly
 * (a `*` inside a label matches characters within that label).
 */
export function hostMatches(pattern, host) {
  const p = pattern.toLowerCase().replace(/\.$/, '').split('.');
  const h = host.toLowerCase().replace(/\.$/, '').split('.');
  const label = (pl, hl) => (pl.includes('*') ? globToRegExp(pl, { star: '[^.]*' }).test(hl) : pl === hl);
  const go = (i, j) => {
    if (i === p.length) return j === h.length;
    if (p[i] === '*') {
      for (let k = j + 1; k <= h.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    return j < h.length && label(p[i], h[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

/** Current branch from .git/HEAD (fast path), else `git rev-parse`. null when detached/unknown. */
export function currentBranch(dir) {
  try {
    let d = dir;
    for (;;) {
      const g = path.join(d, '.git');
      if (fs.existsSync(g)) {
        let gitDir = g;
        if (fs.statSync(g).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(g, 'utf8'));
          if (m) gitDir = path.resolve(d, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const m = /^ref: refs\/heads\/(.+)$/.exec(head);
        return m ? m[1] : null;
      }
      const parent = path.dirname(d);
      if (parent === d) break;
      d = parent;
    }
  } catch { /* fall through */ }
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 500 });
    const b = r.status === 0 ? r.stdout.trim() : '';
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

function localBranches(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], { encoding: 'utf8', timeout: 1000 });
    return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

const PUSH_VALUE_OPTS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/**
 * Branches a `git push` segment would update.
 * @param {import('../parse/tokenize.js').Segment} seg
 */
export function pushTargets(seg, { branch = currentBranch, branches = localBranches } = {}) {
  const g = gitSub(seg);
  if (!g || g.sub !== 'push') return null;
  const positional = [];
  let all = false;
  for (let i = 0; i < g.args.length; i++) {
    const a = g.args[i];
    if (a === '--all' || a === '--mirror' || a === '--branches') { all = true; continue; }
    if (a.startsWith('-')) {
      if (!a.includes('=') && PUSH_VALUE_OPTS.has(a)) i++;
      continue;
    }
    positional.push(a);
  }
  if (all) return branches(g.dir);
  const refspecs = positional.slice(1);
  if (!refspecs.length) {
    const b = branch(g.dir);
    return b ? [b] : [];
  }
  const out = [];
  for (let r of refspecs) {
    r = r.replace(/^\+/, '');
    let dst = r.includes(':') ? r.slice(r.indexOf(':') + 1) : r;
    if (!dst) continue;
    if (dst === 'HEAD' || dst === '@') dst = branch(g.dir) || '';
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst && !dst.startsWith('refs/tags/')) out.push(dst);
  }
  return out;
}

const NEXT_BLOCKED = 'this is blocked here; tell the user what you need and why';

/**
 * @param {import('./policy.js').Boundary} b
 * @param {string} summary
 */
function refusalFor(b, summary, detail = {}) {
  const alt = b.alternative;
  const fromRepo = b.layer === 'repo' && alt ? ' (from repo policy)' : '';
  return {
    reason: 'policy_blocked',
    summary,
    evidence: `source: ${b.source}${b.why ? ` · ${b.why}` : ''}`,
    next: alt ? `use ${alt} instead${fromRepo}` : NEXT_BLOCKED,
    exit: EXIT.POLICY,
    details: { kind: b.kind, pattern: b.pattern, layer: b.layer, ...detail },
    boundary: b,
  };
}

/**
 * Check every segment against the boundaries.
 * @param {import('../parse/tokenize.js').Parsed} parsed
 * @param {ReturnType<import('./policy.js').mergeLayers> & { suspected?: any[] }} policy
 * @param {{ env?: NodeJS.ProcessEnv, home?: string, resolveGitRemote?: Function, branch?: Function, branches?: Function }} [o]
 * @returns {{ refusal: any | null, notes: string[], hosts: string[] }}
 */
export function boundaryCheck(parsed, policy, o = {}) {
  const notes = [];
  const hostsSeen = [];
  if (parsed.opaque) return { refusal: null, notes, hosts: hostsSeen };
  const bounds = policy.boundaries || [];
  const hostBounds = bounds.filter((b) => b.kind === 'host');
  const suspected = policy.suspected || [];
  const wantHosts = hostBounds.length > 0 || suspected.length > 0;
  const env = o.env || process.env;
  const home = o.home || os.homedir();

  for (const seg of parsed.segments) {
    if (!seg.name) continue;
    for (const b of bounds) {
      if (b.kind === 'program' && (seg.name.toLowerCase() === b.pattern.toLowerCase() || seg.program === b.pattern)) {
        return { refusal: refusalFor(b, `${b.pattern} is blocked here`), notes, hosts: hostsSeen };
      }
      if (b.kind === 'command' && globToRegExp(b.pattern).test(seg.text)) {
        return { refusal: refusalFor(b, `\`${b.pattern}\` is blocked here`), notes, hosts: hostsSeen };
      }
    }
    const gitPush = bounds.some((b) => b.kind === 'git_push') ? pushTargets(seg, { branch: o.branch, branches: o.branches }) : null;
    if (gitPush) {
      for (const target of gitPush) {
        const b = bounds.find((x) => x.kind === 'git_push' && globToRegExp(x.pattern).test(target));
        if (b) return { refusal: refusalFor(b, `pushing to ${target} is blocked here`, { branch: target }), notes, hosts: hostsSeen };
      }
    }
    if (!wantHosts) continue;
    const refs = [
      ...explicitHosts(seg, { resolveGitRemote: o.resolveGitRemote || gitRemoteUrl }),
      ...implicitHosts(seg, { env, home }),
    ];
    for (const ref of refs) {
      hostsSeen.push(ref.host);
      const b = hostBounds.find((x) => hostMatches(x.pattern, ref.host));
      if (b) {
        const summary = ref.how === 'implicit'
          ? `${seg.name} ${seg.args.find((a) => !a.startsWith('-')) || ''} would use ${ref.host}, which is blocked here`
          : `${ref.host} is blocked here`;
        return { refusal: refusalFor(b, summary.replace(/ {2,}/g, ' '), { host: ref.host }), notes, hosts: hostsSeen };
      }
      const s = suspected.find((e) => hostMatches(e.pattern, ref.host));
      if (s) notes.push(`${ref.host} may be blocked here (seen ${s.hits} time${s.hits === 1 ? '' : 's'})`);
    }
  }
  return { refusal: null, notes: [...new Set(notes)], hosts: [...new Set(hostsSeen)] };
}
