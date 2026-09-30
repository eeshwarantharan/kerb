#!/bin/sh
# Lint, sign and verify the org policy bundle.
#   SIGNING_KEY_FILE  path to the Ed25519 private key (from `kerb policy keygen`)
#   PUBLIC_KEY        the matching public key (base64), as pinned in the managed config
#   BUNDLE_VERSION    whole number, e.g. the CI run number
#   KERB_CMD          how to call kerb (default: kerb)
#   OUT               output bundle path (default: dist/kerb-bundle.json)
set -eu
cd "$(dirname "$0")/.."
KERB_CMD="${KERB_CMD:-kerb}"
OUT="${OUT:-dist/kerb-bundle.json}"
: "${SIGNING_KEY_FILE:?set SIGNING_KEY_FILE}"
: "${PUBLIC_KEY:?set PUBLIC_KEY}"
: "${BUNDLE_VERSION:?set BUNDLE_VERSION}"
mkdir -p "$(dirname "$OUT")"
$KERB_CMD policy lint policy.json
$KERB_CMD policy sign policy.json --key "$SIGNING_KEY_FILE" --bundle-version "$BUNDLE_VERSION" --out "$OUT"
$KERB_CMD policy verify "$OUT" --pub "$PUBLIC_KEY"
echo "signed $OUT (bundle v$BUNDLE_VERSION)"
