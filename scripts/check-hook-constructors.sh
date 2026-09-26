#!/usr/bin/env bash
set -euo pipefail

# Approximate guard for unstable references inside hook callbacks.
# Intentionally lightweight: catches obvious regressions quickly in CI.
matches="$(
  grep -RInE 'new Map\(|new Set\(|new Object\(' src/web --include='*.tsx' \
    | grep -v 'useMemo' \
    | grep -E 'useEffect|useCallback' \
    || true
)"

if [[ -n "${matches}" ]]; then
  echo "Potential unstable constructor allocations inside hook callbacks:"
  echo "${matches}"
  exit 1
fi

echo "No obvious hook constructor allocation regressions detected."
