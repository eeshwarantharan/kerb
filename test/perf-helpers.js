// Generators for performance tests (not a test suite).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

/** A git repo with n files, fsmonitor and the untracked cache enabled, all committed. */
export function makeBigRepo(n) {
  const dir = tmpDir('kerb-big-');
  for (let i = 0; i < n; i++) {
    const d = path.join(dir, `pkg${i % 100}`, `d${Math.floor(i / 100) % 100}`);
    if (i < 10_000) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `f${i}.txt`), `${i}\n`);
  }
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', maxBuffer: 1 << 30 });
  g('init', '-q');
  g('config', 'core.untrackedCache', 'true');
  if (process.platform !== 'linux') g('config', 'core.fsmonitor', 'true');
  g('add', '-A');
  g('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'big');
  return { dir };
}
