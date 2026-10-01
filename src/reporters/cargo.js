// cargo test (KERB-V2 5.4): "test tests::adds ... ok", the failures section
// ("---- tests::discount stdout ----", "thread 'tests::discount' (12622256) panicked at
// src/lib.rs:20:9:"; older toolchains omit the thread id). Recorded with cargo 1.99.
// and "test result: FAILED. 1 passed; 1 failed; 1 ignored". The file in a test id is the target
// cargo announces ("Running unittests src/lib.rs (target/debug/deps/…)").
import { lines, repoPath, summarize } from './common.js';

export const framework = 'cargo';

export function parse(text, ctx) {
  if (!/(^|\n)test \S+ \.\.\. (ok|FAILED|ignored)/.test(text)) return null;
  const tests = new Map();
  let target = '';
  let section = null;
  for (const line of lines(text, ctx.deadline)) {
    let m;
    if ((m = /^\s+Running (?:unittests )?(\S+) \(/.exec(line))) { target = repoPath(m[1], ctx); continue; }
    if ((m = /^\s+Doc-tests (\S+)/.exec(line))) { target = `doc:${m[1]}`; continue; }
    if ((m = /^test (\S+?)(?: - should panic)? \.\.\. (ok|FAILED|ignored)/.exec(line))) {
      tests.set(`${target}::${m[1]}`, { file: target, name: m[1], status: m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skip', location: null, message: null, duration_ms: null });
      continue;
    }
    if ((m = /^---- (\S+) stdout ----$/.exec(line))) { section = tests.get(`${target}::${m[1]}`) || null; continue; }
    if (section && (m = /^thread '.+?'(?: \(\d+\))? panicked at (\S+?):(\d+):\d+:?$/.exec(line))) { section.location = `${repoPath(m[1], ctx)}:${m[2]}`; section.expectMessage = true; continue; }
    if (section && section.expectMessage && line.trim()) { section.message = line.trim(); section.expectMessage = false; section = null; }
  }
  const results = [...tests.values()].map(({ expectMessage, ...r }) => r);
  return { framework, results, summary: summarize(results) };
}
