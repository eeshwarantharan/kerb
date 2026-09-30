#!/usr/bin/env node
// Write a CycloneDX 1.5 JSON SBOM. Kerb has no runtime or dev dependencies; the standalone
// binaries embed the official Node.js runtime, which is listed as a component.
//   node scripts/sbom.js [--node-version v24.21.0] [--out dist/kerb.cdx.json]
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const nodeVersion = opt('node-version', 'v24.21.0').replace(/^v/, '');
if (pkg.dependencies || pkg.devDependencies) throw new Error('package.json must not declare dependencies');

export const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: 'application',
      'bom-ref': `pkg:npm/${pkg.name}@${pkg.version}`,
      name: pkg.name,
      version: pkg.version,
      licenses: [{ license: { id: pkg.license } }],
      purl: `pkg:npm/${pkg.name}@${pkg.version}`,
    },
  },
  components: [
    {
      type: 'platform',
      'bom-ref': `pkg:generic/nodejs@${nodeVersion}`,
      name: 'node',
      version: nodeVersion,
      description: 'Node.js runtime embedded in the standalone binaries (not a dependency of the npm package)',
      licenses: [{ license: { id: 'MIT' } }],
      purl: `pkg:generic/nodejs@${nodeVersion}?download_url=https://nodejs.org/dist/v${nodeVersion}/`,
    },
  ],
  dependencies: [{ ref: `pkg:npm/${pkg.name}@${pkg.version}`, dependsOn: [] }],
};

const out = path.resolve(root, opt('out', 'dist/kerb.cdx.json'));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}`);
