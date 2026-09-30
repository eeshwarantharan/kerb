#!/bin/sh
# Create the kerb-demo repository used in the launch demo (docs/KERB.md 12.2):
# a policy that blocks registry.npmjs.org (alternative: a local Verdaccio mirror), a protected
# main branch, one real failing test, and a test database that takes about 20 seconds to start.
#   sh demo/setup.sh [dir]
set -eu
DIR="${1:-kerb-demo}"
mkdir -p "$DIR" && cd "$DIR"
git init -q -b main

cat > package.json <<'JSON'
{
  "name": "kerb-demo",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test",
    "db:up": "sh scripts/db-up.sh &"
  }
}
JSON

cat > .npmrc <<'NPMRC'
# Public registries are blocked here; this is what the agent should use (Verdaccio on localhost).
# Remove this line to see Kerb refuse the install and name the mirror.
NPMRC

cat > kerb.policy.json <<'POLICY'
{
  "version": 1,
  "boundaries": [
    { "kind": "host", "pattern": "registry.npmjs.org", "alternative": "http://localhost:4873", "why": "Public registries are blocked; use the local mirror." },
    { "kind": "git_push", "pattern": "main", "why": "main is protected; open a pull request." }
  ],
  "fixes": [
    { "key_contains": "npm test", "output_contains": "ECONNREFUSED 127.0.0.1:5433", "hint": "The test database starts in the background: npm run db:up" }
  ]
}
POLICY

mkdir -p scripts src test
cat > scripts/db-up.sh <<'SH'
#!/bin/sh
# A "database" that accepts connections on 127.0.0.1:5433 after about 20 seconds.
sleep 20
exec node -e "require('net').createServer((s) => s.end('ok')).listen(5433, '127.0.0.1')"
SH

cat > src/pad.js <<'JS'
// Pad a string on the left to the given width. (Bug on purpose: pads on the right.)
export function padLeft(s, width, ch = ' ') {
  return String(s) + ch.repeat(Math.max(0, width - String(s).length));
}
JS

cat > test/pad.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { padLeft } from '../src/pad.js';

test('the test database is reachable', async () => {
  await new Promise((resolve, reject) => {
    const s = net.connect(5433, '127.0.0.1', () => { s.end(); resolve(); });
    s.on('error', reject);
  });
});

test('padLeft pads on the left', () => {
  assert.equal(padLeft('7', 3, '0'), '007');
});
JS

git add -A
git -c user.name=demo -c user.email=demo@example.com commit -qm "kerb demo"
git checkout -q -b feature/left-pad
echo "kerb-demo ready in $DIR. Next: start a mirror (npx verdaccio), run 'kerb init', then start your agent."
