#!/usr/bin/env node
// Turn failing tests in a saved `node --test` (TAP) log into GitHub annotations, so failures
// are visible on the run page and through the public API without opening the raw log.
//   node --test 2>&1 | tee test-output.txt; node scripts/ci-annotate.js test-output.txt
import fs from 'node:fs';

const text = fs.readFileSync(process.argv[2] || 'test-output.txt', 'utf8');
const lines = text.split(/\r?\n/);
const out = [];
for (let i = 0; i < lines.length && out.length < 45; i++) {
  const m = /^\s*not ok \d+ - (.+)$/.exec(lines[i]);
  if (!m || /^(\/|[A-Z]:\\)/.test(m[1])) continue;
  let detail = '';
  for (let j = i + 1; j < Math.min(lines.length, i + 40); j++) {
    const l = lines[j];
    if (/^\s*(ok|not ok) \d+/.test(l)) break;
    const e = /^\s*error: (?:\|-|'|")?(.*?)['"]?$/.exec(l);
    if (e) {
      detail = e[1] || (lines[j + 1] || '').trim();
      if (!e[1]) for (let k = j + 2; k < j + 5 && lines[k] && !/^\s*(code|name|expected|actual|stack):/.test(lines[k]); k++) detail += ` ${lines[k].trim()}`;
      break;
    }
  }
  const msg = `${m[1]} :: ${detail}`.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A').slice(0, 900);
  out.push(`::error title=test failed::${msg}`);
}
for (const l of out) console.log(l);
const summary = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(text);
if (summary) console.log(`::notice title=tests::pass ${summary[1]}, fail ${summary[2]}`);
