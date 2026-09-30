#!/usr/bin/env node
import module from 'node:module';

// Node 22+ caches compiled modules between runs, which keeps hooks and `kerb check` fast.
if (typeof module.enableCompileCache === 'function') {
  try { module.enableCompileCache(); } catch { /* optional */ }
}
const { main } = await import('../src/cli/main.js');

main(process.argv.slice(2)).then(
  (code) => finish(code),
  (err) => {
    process.stderr.write(`kerb: error · internal error: ${err && err.message ? err.message : err}\n`);
    finish(70);
  },
);

function finish(code) {
  // Flush stdout before exiting so piped JSON is never truncated.
  const exit = () => process.exit(typeof code === 'number' ? code : 70);
  if (process.stdout.writableLength > 0) process.stdout.write('', exit);
  else exit();
}
