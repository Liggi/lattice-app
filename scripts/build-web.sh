#!/bin/bash
# Builds the web client into dist/web without touching the server: a server
# that serves its built client (a built install, or a source checkout started
# with LATTICE_CLIENT=built) reads dist/web on every request, so the next page
# load gets the new client. No restart.
#
# Builds to a staging directory and swaps it in with renames, so a page load
# never sees a half-written dist/web. The previous build's assets are carried
# into the new one, so a page opened before the swap can still load the lazy
# chunks it names; carried files older than a week are dropped.

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

STAGING="dist/web-staging"
OLD="dist/web-old"

# shellcheck source=scripts/build-lock.sh
source "$PROJECT_DIR/scripts/build-lock.sh"
acquire_lock

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Web build failed (exit $exit_code), dist/web unchanged"
  fi
  rm -rf "$STAGING" "$OLD"
  release_lock
}
trap cleanup EXIT

mkdir -p dist
# A swap cut off between its two renames leaves only the old build.
if [ ! -d dist/web ] && [ -d "$OLD" ]; then
  mv "$OLD" dist/web
fi
rm -rf "$STAGING" "$OLD"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Web build started"
# Vite's root is src/web, so outDir is relative to it.
NODE_ENV=production pnpm exec vite build --outDir "../../$STAGING" --emptyOutDir

if [ -d dist/web/assets ]; then
  find dist/web/assets -type f -mtime -7 -print0 | while IFS= read -r -d '' file; do
    name="${file#dist/web/assets/}"
    [ -e "$STAGING/assets/$name" ] || { mkdir -p "$(dirname "$STAGING/assets/$name")"; cp -p "$file" "$STAGING/assets/$name"; }
  done
fi

if [ -d dist/web ]; then
  mv dist/web "$OLD"
fi
mv "$STAGING" dist/web
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Web build complete: dist/web"
