#!/usr/bin/env node
// Generate the Homebrew formula for the tap from the release's SHA256SUMS.
//   node scripts/homebrew.js --version 1.0.0 --sums dist/bin/SHA256SUMS [--repo eeshwarantharan/kerb] [--out Formula/kerb.rb]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const version = opt('version');
const sumsFile = opt('sums');
const repo = opt('repo', 'eeshwarantharan/kerb');
if (!version || !sumsFile) { console.error('usage: node scripts/homebrew.js --version X --sums SHA256SUMS'); process.exit(64); }

const sums = Object.fromEntries(fs.readFileSync(sumsFile, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/).reverse()));
const need = ['kerb-darwin-arm64', 'kerb-darwin-x64', 'kerb-linux-arm64', 'kerb-linux-x64'];
for (const n of need) if (!sums[n]) { console.error(`missing ${n} in ${sumsFile}`); process.exit(1); }
const url = (n) => `https://github.com/${repo}/releases/download/v${version}/${n}`;

export const formula = `class Kerb < Formula
  desc "Stops AI coding agents from wasting turns on blocked actions and retries that can't help"
  homepage "https://github.com/${repo}"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "${url('kerb-darwin-arm64')}"
      sha256 "${sums['kerb-darwin-arm64']}"
    end
    on_intel do
      url "${url('kerb-darwin-x64')}"
      sha256 "${sums['kerb-darwin-x64']}"
    end
  end

  on_linux do
    on_arm do
      url "${url('kerb-linux-arm64')}"
      sha256 "${sums['kerb-linux-arm64']}"
    end
    on_intel do
      url "${url('kerb-linux-x64')}"
      sha256 "${sums['kerb-linux-x64']}"
    end
  end

  def install
    bin.install Dir["kerb-*"].first => "kerb"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kerb --version")
    system bin/"kerb", "doctor"
  end
end
`;

const out = opt('out', 'Formula/kerb.rb');
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, formula);
console.log(`wrote ${out}`);
