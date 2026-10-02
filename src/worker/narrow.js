// Narrowing (KERB-V2 8.2): a command that runs only one test, per framework. The probe reads
// the target test's own result from the parsed output, so a narrowed command that also runs a
// same-named test elsewhere still gives the right answer.
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "framework:file::name" → { framework, file, name }. */
export function splitTestId(id) {
  const c = id.indexOf(':');
  const d = id.indexOf('::', c + 1);
  if (c === -1 || d === -1) return null;
  return { framework: id.slice(0, c), file: id.slice(c + 1, d), name: id.slice(d + 2) };
}

/** The runner prefix the original command used (`pnpm`, `npx`, `yarn`…), so the same binary runs. */
function prefix(command, tool) {
  const m = new RegExp(`(?:^|[;&|]\\s*)((?:\\S+ )*?)${tool}\\b`).exec(String(command || ''));
  const p = m ? m[1].trim() : '';
  return /^(npx|pnpm|pnpm exec|pnpm dlx|yarn|bunx|bun x)$/.test(p) ? `${p} ` : 'npx ';
}

/**
 * @param {string} testId
 * @param {string} command the key's original command
 * @returns {string | null} null when the framework can't run one test
 */
export function narrowCommand(testId, command) {
  const t = splitTestId(testId);
  if (!t) return null;
  const parts = t.name.split(' > ');
  const leaf = parts[parts.length - 1];
  switch (t.framework) {
    case 'vitest':
      // -t matches the full name: suites and test joined by spaces.
      return `${prefix(command, 'vitest')}vitest run ${q(t.file)} -t ${q(`^${reEscape(parts.join(' '))}$`)}`;
    case 'jest':
      return `${prefix(command, 'jest')}jest ${q(t.file)} -t ${q(`^${reEscape(parts.join(' '))}$`)}`;
    case 'pytest': {
      const runner = /python[0-9.]* -m pytest/.exec(command || '');
      return `${runner ? runner[0] : 'pytest'} ${q(`${t.file}::${parts.join('::')}`)}`;
    }
    case 'go': {
      // Subtests: go splits -run on '/' and matches each level separately.
      const levels = t.name.split('/').map((n) => `^${reEscape(n)}$`).join('/');
      return `go test -count=1 -run ${q(levels)} ${q(t.file)}`;
    }
    case 'cargo': {
      const target = /^src\/(lib|main)\.rs$/.test(t.file) ? (t.file.endsWith('lib.rs') ? '--lib ' : '--bin ') : /^tests\/(.+)\.rs$/.exec(t.file) ? `--test ${q(/^tests\/(.+)\.rs$/.exec(t.file)[1])} ` : '';
      return `cargo test ${target}${q(t.name)} -- --exact`;
    }
    case 'node': {
      // Node 20 matches the test's own name; later versions the full name. Both end with the leaf.
      const files = String(command || '').split(/\s+/).filter((w) => /\.(test|spec)\.[cm]?[jt]s$|(^|\/)test\.[cm]?[jt]s$/.test(w));
      const file = t.file || (files.length === 1 ? files[0] : '');
      return `node --test --test-name-pattern=${q(`(^| )${reEscape(leaf)}$`)}${file ? ` ${q(file)}` : ''}`;
    }
    default:
      return null; // diagnostics and JUnit: the original command, with a smaller budget
  }
}
