#!/usr/bin/env bash
# Signs the add-on as an unlisted version on addons.mozilla.org and opens it in Firefox to install.
#
#   scripts/sign-and-install.sh
#
# Run it in a terminal (it asks for your AMO API credentials the first time, from
# https://addons.mozilla.org/developers/addon/api/key/, and keeps them in the macOS Keychain
# under "tabwright-amo"). WEB_EXT_API_KEY / WEB_EXT_API_SECRET in the environment take precedence.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(node -p 'require("./extension/manifest.json").version')
XPI="web-ext-artifacts/tabwright-${VERSION}.xpi"
SERVICE="tabwright-amo"

keychain_get() { security find-generic-password -s "$SERVICE" -a "$1" -w 2>/dev/null || true; }

if [[ -z "${WEB_EXT_API_KEY:-}" || -z "${WEB_EXT_API_SECRET:-}" ]]; then
  WEB_EXT_API_KEY=$(keychain_get api-key)
  WEB_EXT_API_SECRET=$(keychain_get api-secret)
  if [[ -z "$WEB_EXT_API_KEY" || -z "$WEB_EXT_API_SECRET" ]]; then
    echo "Your addons.mozilla.org API credentials (https://addons.mozilla.org/developers/addon/api/key/)"
    read -r -p "  JWT issuer (user:12345:678): " WEB_EXT_API_KEY
    read -r -s -p "  JWT secret (hidden): " WEB_EXT_API_SECRET
    echo
    security add-generic-password -U -s "$SERVICE" -a api-key -w "$WEB_EXT_API_KEY"
    security add-generic-password -U -s "$SERVICE" -a api-secret -w "$WEB_EXT_API_SECRET"
    echo "Saved to the Keychain as \"$SERVICE\"; next time you won't be asked."
  fi
fi
export WEB_EXT_API_KEY WEB_EXT_API_SECRET

if [[ -f "$XPI" ]]; then
  echo "Already signed: $XPI"
else
  echo "Building the MCP server and host..."
  npm run build --silent
  echo "Signing Tabwright $VERSION (unlisted). Mozilla usually takes a few minutes..."
  npx web-ext sign --source-dir extension --channel=unlisted --artifacts-dir web-ext-artifacts
  # web-ext names the file after the add-on; normalise it so the next run finds it.
  latest=$(ls -t web-ext-artifacts/*.xpi | head -1)
  [[ "$latest" != "$XPI" ]] && mv "$latest" "$XPI"
fi

# Publish the signed build so Firefox can self-update: a GitHub release holds the .xpi and
# updates.json (served from main via raw.githubusercontent.com, the manifest's update_url) points at it.
if command -v gh >/dev/null 2>&1; then
  TAG="v$VERSION"
  if ! gh release view "$TAG" >/dev/null 2>&1; then
    gh release create "$TAG" "$XPI" --title "Tabwright $VERSION" --notes "Signed unlisted build of Tabwright $VERSION."
  fi
  REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
  node scripts/update-manifest.mjs "$VERSION" "https://github.com/$REPO/releases/download/$TAG/tabwright-$VERSION.xpi" "$XPI"
  if ! git diff --quiet -- updates.json; then
    git add updates.json
    git commit -q -m "Publish Tabwright $VERSION to updates.json"
    git push -q origin HEAD
  fi
else
  echo "gh not found: skipping the GitHub release, so Firefox won't auto-update to $VERSION."
fi

echo "Opening $XPI in Firefox. Click Add (it asks for the new clipboard permission)."
open -a Firefox "$XPI"
echo
echo "Done. In Claude Code, run /mcp and reconnect tabwright."
