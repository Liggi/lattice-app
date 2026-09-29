#!/bin/bash
# Safe build: builds to staging directory, atomically swaps into dist/.
# Server never sees half-built output. mkdir-based lock prevents concurrent builds.

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

STAGING="dist-staging"
DEPLOY=false
SKIP_LINT=false

# Parse flags
for arg in "$@"; do
  case $arg in
    --deploy) DEPLOY=true ;;
    --skip-lint) SKIP_LINT=true ;;
  esac
done

# shellcheck source=scripts/build-lock.sh
source "$PROJECT_DIR/scripts/build-lock.sh"
acquire_lock

# Warn if deploying with uncommitted changes — these survive the deploy but
# will be lost on the next server restart if someone else builds from committed code.
if [ "$DEPLOY" = true ]; then
  dirty=""
  if [ -d "$PROJECT_DIR/.git" ]; then
    changes=$(git -C "$PROJECT_DIR" diff --stat HEAD -- src/ packages/*/src/ 2>/dev/null)
    if [ -n "$changes" ]; then
      count=$(echo "$changes" | grep -c '|')
      dirty="lattice ($count files)"
    fi
  fi
  if [ -n "$dirty" ]; then
    echo ""
    echo "⚠️  UNCOMMITTED CHANGES: $dirty"
    echo "⚠️  Deploy will use working tree code, but a future rebuild from committed code will lose these changes."
    echo "⚠️  Consider committing first."
    echo ""
  fi
fi

# Run agent-ui-harness tests before building — changes there can silently
# break session lifecycle.
harness_dir="$PROJECT_DIR/packages/harness"
if [ -f "$harness_dir/package.json" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running agent-ui-harness tests..."
  # Capture rather than pipe. `cmd | tail -5` reports tail's exit status, so the
  # abort below was unreachable and a harness that could not even start still
  # deployed.
  harness_status=0
  harness_output="$(cd "$harness_dir" && npx vitest run --reporter=dot 2>&1)" || harness_status=$?
  echo "$harness_output" | tail -5
  if [ "$harness_status" -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Harness tests failed — aborting deploy"
    release_lock
    exit 1
  fi
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Build started (safe mode)"

# Recovery: if a previous build was killed mid-swap, restore
if [ ! -d "dist" ] && [ -d "dist-old" ]; then
  echo "Recovering from interrupted swap..."
  mv dist-old dist
fi

# Cleanup function — on failure, remove staging, leave dist untouched. Always release lock.
cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Build failed (exit $exit_code), dist/ unchanged"
    rm -rf "$STAGING"
  fi
  release_lock
}
trap cleanup EXIT

# Clean staging (never touch live dist/)
rm -rf "$STAGING" dist-old

# Lint
if [ "$SKIP_LINT" = false ]; then
  pnpm run lint
fi

# Build web to staging
# Vite root is src/web, so outDir is relative to that
NODE_ENV=production pnpm exec vite build --outDir "../../$STAGING/web"

# Compile TypeScript to staging.
pnpm exec tsc --outDir "$STAGING"

# Rewrite path aliases in staging
pnpm exec tsc-alias --outDir "$STAGING"

# Make entry points executable
chmod +x "$STAGING/process-daemon/index.js" 2>/dev/null || true
chmod +x "$STAGING/server.js" 2>/dev/null || true
chmod +x "$STAGING/cli.js" 2>/dev/null || true

# Atomic swap
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Swapping dist..."
if [ -d "dist" ]; then
  mv dist dist-old
fi
mv "$STAGING" dist
rm -rf dist-old

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Build complete (safe mode)"

# Optional: restart server
if [ "$DEPLOY" = true ]; then
  bash scripts/restart-server.sh
fi
