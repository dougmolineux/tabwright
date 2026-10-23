#!/bin/sh
# Builds the two files an addons.mozilla.org submission needs (docs/amo-listing.md):
#   web-ext-artifacts/tabwright-<version>.zip          the add-on to upload
#   web-ext-artifacts/tabwright-<version>-source.zip   the source, since extension/lib/protocol.js is generated
# The source zip is `git archive HEAD`, so commit first: the uploaded add-on must match the source.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
VERSION=$(node -p 'require("./extension/manifest.json").version')
OUT="$ROOT/web-ext-artifacts"

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes. Commit them first so the source zip matches the add-on." >&2
  exit 1
fi

npm ci --no-audit --no-fund
npm run build
# The committed protocol.js must be exactly what the build produces, or reviewers can't reproduce it.
git diff --exit-code -- extension/lib/protocol.js || {
  echo "extension/lib/protocol.js is out of date; commit the rebuilt file." >&2
  exit 1
}
npm run ext:lint

mkdir -p "$OUT"
npx web-ext build --source-dir extension --artifacts-dir "$OUT" --filename "tabwright-$VERSION.zip" --ignore-files package.json --overwrite-dest
git archive --format=zip --prefix="tabwright-$VERSION/" -o "$OUT/tabwright-$VERSION-source.zip" HEAD

echo
echo "Upload to addons.mozilla.org:"
echo "  add-on: $OUT/tabwright-$VERSION.zip"
echo "  source: $OUT/tabwright-$VERSION-source.zip"
