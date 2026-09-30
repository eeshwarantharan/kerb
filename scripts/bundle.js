#!/usr/bin/env node
// Bundle src/ (ES modules) into one CommonJS file for the Node single-executable build.
// This is a small, purpose-built transform for Kerb's own code style: named imports and
// exports, `export default` functions, dynamic `import()` of relative paths or builtins,
// and `import.meta.url`. The module graph has no static cycles (checked below).
//   node scripts/bundle.js [--out dist/kerb.cjs]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(root, outArg === -1 ? 'dist/kerb.cjs' : process.argv[outArg + 1]);

function listSources() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(root, 'src'));
  return files.sort();
}

const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
const resolveFrom = (file, spec) => rel(path.resolve(path.dirname(file), spec));

/** `a, b as c` → `a, b: c` for destructuring. */
const destructure = (names) => names.split(',').map((n) => n.trim()).filter(Boolean)
  .map((n) => n.replace(/^(\w+)\s+as\s+(\w+)$/, '$1: $2')).join(', ');

export function transform(code, file) {
  const id = rel(file);
  const exported = [];
  const deps = [];
  let s = code;

  // Static imports.
  s = s.replace(/^import\s+([\s\S]+?)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (m, clause, spec) => {
    const target = spec.startsWith('.') ? `__kerbReq(${JSON.stringify(resolveFrom(file, spec))})` : `require(${JSON.stringify(spec)})`;
    if (spec.startsWith('.')) deps.push(resolveFrom(file, spec));
    clause = clause.trim();
    if (clause.startsWith('{')) return `const { ${destructure(clause.slice(1, -1))} } = ${target};`;
    if (clause.startsWith('* as ')) return `const ${clause.slice(5).trim()} = ${target};`;
    if (/^\w+$/.test(clause)) {
      if (spec.startsWith('.')) throw new Error(`${id}: default import from ${spec} is not supported`);
      return `const ${clause} = ${target};`;
    }
    throw new Error(`${id}: unsupported import clause: ${clause}`);
  });
  if (/^import\s/m.test(s)) throw new Error(`${id}: an import statement was not transformed`);

  // Dynamic imports.
  s = s.replace(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, (m, spec) => (spec.startsWith('.')
    ? `Promise.resolve(__kerbReq(${JSON.stringify(resolveFrom(file, spec))}))`
    : `Promise.resolve(require(${JSON.stringify(spec)}))`));
  if (/\bimport\(/.test(s)) throw new Error(`${id}: a dynamic import with a computed specifier is not supported`);

  s = s.replace(/\bimport\.meta\.url\b/g, '__kerbMetaUrl');

  // Re-exports.
  s = s.replace(/^export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm, (m, names, spec) => {
    const target = resolveFrom(file, spec);
    deps.push(target);
    const parts = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => {
      const [a, b] = n.split(/\s+as\s+/);
      return `exports.${b || a} = __r.${a};`;
    });
    return `{ const __r = __kerbReq(${JSON.stringify(target)}); ${parts.join(' ')} }`;
  });
  s = s.replace(/^export\s+\{([^}]+)\};?[ \t]*$/gm, (m, names) => {
    for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [a, b] = n.split(/\s+as\s+/);
      exported.push([b || a, a]);
    }
    return '';
  });
  s = s.replace(/^export\s+default\s+(async\s+)?function\s+(\w+)/gm, (m, a, name) => { exported.push(['default', name]); return `${a || ''}function ${name}`; });
  s = s.replace(/^export\s+(async\s+function|function|class|const|let)\s+(\w+)/gm, (m, kind, name) => { exported.push([name, name]); return `${kind} ${name}`; });
  if (/^export\s/m.test(s)) throw new Error(`${id}: an export statement was not transformed`);

  const tail = exported.map(([as, local]) => `exports.${as} = ${local};`).join('\n');
  return { id, deps, body: `${s}\n${tail}\n` };
}

function checkCycles(mods) {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const state = new Map();
  const visit = (id, stack) => {
    if (state.get(id) === 1) throw new Error(`static import cycle: ${[...stack, id].join(' -> ')}`);
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const d of (byId.get(id) || { deps: [] }).deps) visit(d, [...stack, id]);
    state.set(id, 2);
  };
  for (const m of mods) visit(m.id, []);
}

export function bundle() {
  const mods = listSources().map((f) => transform(fs.readFileSync(f, 'utf8'), f));
  checkCycles(mods);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const table = mods.map((m) => `${JSON.stringify(m.id)}: function (exports, __kerbReq, __kerbMetaUrl) {\n${m.body}}`).join(',\n');
  return `'use strict';
// Kerb ${pkg.version}, bundled for the standalone binary. Generated by scripts/bundle.js; do not edit.
globalThis.require = require;
globalThis.__KERB_BUNDLE__ = true;
const __kerbMods = {
${table}
};
const __kerbCache = {};
function __kerbReq(id) {
  if (__kerbCache[id]) return __kerbCache[id];
  const exports = {};
  __kerbCache[id] = exports;
  const fn = __kerbMods[id];
  if (!fn) throw new Error('kerb bundle: missing module ' + id);
  fn(exports, __kerbReq, 'file:///kerb/' + id);
  return exports;
}
const __args = process.argv.slice(2);
__kerbReq('src/cli/main.js').main(__args).then(
  (code) => { const exit = () => process.exit(typeof code === 'number' ? code : 70); if (process.stdout.writableLength > 0) process.stdout.write('', exit); else exit(); },
  (err) => { process.stderr.write('kerb: error · internal error: ' + (err && err.message ? err.message : err) + '\\n'); process.exit(70); },
);
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const text = bundle();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`wrote ${path.relative(root, out)} (${(text.length / 1024).toFixed(0)} KB)`);
}
