// JUnit XML (KERB-V2 5.4): <testcase classname name file line time> with <failure>, <error> or
// <skipped>. Written by pytest --junitxml, Maven Surefire, Gradle, go-junit-report and others.
// pytest reports are recognised and given pytest test ids, so they match pytest's text output.
import { repoPath, summarize } from './common.js';

const unescape = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, '\n').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const attrs = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], unescape(m[2])]));

export function parse(xml, ctx) {
  if (!/<testcase\b/.test(xml)) return null;
  const pytest = /<testsuite[^>]*\bname="pytest"/.test(xml);
  const results = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (ctx.deadline && Date.now() > ctx.deadline) return null;
    const a = attrs(m[1]);
    const body = m[3] || '';
    let status = 'pass';
    let message = null;
    const f = /<(failure|error)\b([^>]*)>/.exec(body) || /<(failure|error)\b([^>]*)\/>/.exec(body);
    if (f) { status = f[1] === 'failure' ? 'fail' : 'error'; message = attrs(f[2]).message || null; } else if (/<skipped\b/.test(body)) status = 'skip';
    let file;
    let name;
    if (pytest) {
      const parts = String(a.classname || '').split('.');
      const cls = [];
      while (parts.length && /^[A-Z]/.test(parts[parts.length - 1])) cls.unshift(parts.pop());
      file = a.file ? repoPath(a.file, ctx) : `${parts.join('/')}.py`;
      name = [...cls, a.name].join(' > ');
    } else {
      file = a.file ? repoPath(a.file, ctx) : a.classname || '';
      name = a.name;
    }
    results.push({ file, name, status, location: a.line ? `${file}:${a.line}` : null, message, duration_ms: a.time ? Number(a.time) * 1000 : null });
  }
  if (!results.length) return null;
  return { framework: pytest ? 'pytest' : 'junit', results, summary: summarize(results) };
}
