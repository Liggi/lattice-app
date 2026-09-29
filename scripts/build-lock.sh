#!/bin/bash
# The build lock shared by safe-build.sh and build-web.sh, which both replace
# parts of dist/. Sourced from the project directory.

# Acquire exclusive lock (blocks if another build is running)
# Uses mkdir for portable locking (works on both Linux and macOS)
LOCKDIR=".build.lockdir"
LOCK_OWNER_FILE="$LOCKDIR/pid"
# A lock directory with no owner file is only trusted briefly: a live build
# writes its pid immediately after mkdir, so a pid-less lock that persists past
# this many polls is wreckage, not a race.
OWNERLESS_LOCK_GRACE_SECONDS=5
acquire_lock() {
  local attempts=0
  local ownerless=0
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    # Recover a lock whose owning build process no longer exists. The owner
    # file makes this safe after abrupt termination while preserving normal
    # serialization between active builds.
    if [ -f "$LOCK_OWNER_FILE" ]; then
      ownerless=0
      local owner_pid
      owner_pid="$(sed -n '1p' "$LOCK_OWNER_FILE")"
      if [[ "$owner_pid" =~ ^[0-9]+$ ]] && ! kill -0 "$owner_pid" 2>/dev/null; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Recovering stale build lock from PID $owner_pid"
        rm -rf "$LOCKDIR"
        continue
      fi
    else
      # No owner file at all. `--deploy` restarts the server, which kills this
      # script's own process group; if that lands between removing the pid file
      # and removing the directory, the leftover directory would otherwise block
      # every future build forever. Reclaim it once it is clearly not a race.
      ownerless=$((ownerless + 1))
      if [ $ownerless -ge $OWNERLESS_LOCK_GRACE_SECONDS ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Recovering ownerless build lock (no pid file)"
        rm -rf "$LOCKDIR"
        ownerless=0
        continue
      fi
    fi
    if [ $attempts -eq 0 ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Another build in progress, waiting..."
    fi
    attempts=$((attempts + 1))
    if [ $attempts -gt 120 ]; then
      echo "[$(date '+%Y-%m-%d %H:%M:%S')] Timed out waiting for build lock after 120s"
      exit 1
    fi
    sleep 1
  done
  echo "$$" > "$LOCK_OWNER_FILE"
}
release_lock() {
  # Single call: removing the pid file and the directory separately leaves an
  # unrecoverable ownerless lock if the process dies between the two.
  rm -rf "$LOCKDIR"
}
