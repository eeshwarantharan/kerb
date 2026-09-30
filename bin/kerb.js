#!/usr/bin/env node
import { main } from '../src/cli/main.js';

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
