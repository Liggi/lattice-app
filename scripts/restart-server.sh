#!/bin/bash
# Restart Lattice server (safe for orchestrator agents to call)
# The daemon stays running, only the server restarts.
# Claude PTYs stay alive but in-flight stream events are NOT buffered across
# the gap — mid-response restarts lose the current turn's output. The next
# user message resumes via --resume.
#
# Falls back to signal-based restart when D-Bus is unavailable
# (e.g. inside Codex sandbox). systemd has Restart=always so
# killing the process triggers an automatic restart.

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restarting Lattice server..."

# The config loader logs to stdout; the URL is the last line.
SERVER_URL="$(npx tsx scripts/print-server-url.ts | tail -n 1)"
source "$PROJECT_DIR/scripts/service-names.sh"

# Ensure logs directory exists
mkdir -p logs

# macOS installs Lattice as a launchd agent. Restart it through launchd rather
# than trying to discover the Node process by command line: BSD pgrep/pkill can
# miss launchd-owned processes, leaving the old server alive while the health
# check incorrectly reports success.
LAUNCHD_SERVICE="gui/$(id -u)/com.lattice.server"
launchd_pid() {
  launchctl print "$LAUNCHD_SERVICE" 2>/dev/null \
    | awk '/^[[:space:]]*pid = / { print $3; exit }'
}

# Only a launchd service that runs this checkout's dist; kickstarting one that
# runs another checkout would restart the wrong server.
if command -v launchctl >/dev/null 2>&1 \
  && launchctl print "$LAUNCHD_SERVICE" 2>/dev/null | grep -qF "$PROJECT_DIR/dist/"; then
  OLD_SERVER_PID="$(launchd_pid)"
  if [ -z "$OLD_SERVER_PID" ]; then
    echo "Could not determine the current launchd server PID"
    exit 1
  fi

  launchctl kickstart -k "$LAUNCHD_SERVICE"
  LAUNCHD_RESTART=true
  echo "Restarted server via launchd"
fi

# Without launchd or the systemd units from `pnpm service:setup`, nothing here
# can restart the server: it runs in whatever terminal started `pnpm start`.
# Say so rather than signalling processes and health-checking the old server.
if [ "${LAUNCHD_RESTART:-}" != "true" ] \
  && [ ! -f "$HOME/.config/systemd/user/$SERVER_UNIT.service" ]; then
  echo "The new build is in dist/, but no launchd or systemd service runs Lattice here."
  echo "Stop the running server (Ctrl+C where you ran pnpm start) and run pnpm start again."
  exit 1
fi

# Try systemctl first; fall back to signal if D-Bus is blocked (Codex sandbox)
try_systemctl() {
  systemctl --user "$@" 2>/dev/null
}

if [ "${LAUNCHD_RESTART:-}" = "true" ]; then
  : # launchd owns both service lifecycle and restart on macOS
elif try_systemctl is-active "$DAEMON_UNIT"; then
  echo "Daemon running via systemd"
else
  if try_systemctl start "$DAEMON_UNIT"; then
    echo "Started daemon via systemd"
    sleep 1
  else
    echo "systemctl unavailable (D-Bus blocked?), using signal-based restart"
    # Kill the server process; systemd Restart=always will bring it back
    pkill -f "node.*$PROJECT_DIR/dist/server\.js" 2>/dev/null && echo "Sent SIGTERM to server" || echo "No server process found"
    sleep 4  # RestartSec=3 + buffer
    # Skip the systemctl restart below
    SIGNAL_RESTART=true
  fi
fi

if [ "${LAUNCHD_RESTART:-}" != "true" ] && [ "${SIGNAL_RESTART:-}" != "true" ]; then
  if try_systemctl is-active "$SERVER_UNIT"; then
    if try_systemctl restart "$SERVER_UNIT"; then
      echo "Restarted server via systemd"
    else
      echo "systemctl restart failed, falling back to signal"
      pkill -f "node.*$PROJECT_DIR/dist/server\.js" 2>/dev/null || true
      sleep 4
    fi
  else
    if ! try_systemctl start "$SERVER_UNIT"; then
      echo "systemctl start failed, falling back to signal"
      pkill -f "node.*$PROJECT_DIR/dist/server\.js" 2>/dev/null || true
      sleep 4
    fi
  fi
fi

sleep 2

# Health check - verify server is responding
echo "Running health check..."
for i in {1..5}; do
  if curl -sf "$SERVER_URL/" > /dev/null 2>&1; then
    if [ "${LAUNCHD_RESTART:-}" = "true" ]; then
      NEW_SERVER_PID="$(launchd_pid)"
      if [ -z "$NEW_SERVER_PID" ] || [ "$NEW_SERVER_PID" = "$OLD_SERVER_PID" ]; then
        sleep 1
        continue
      fi
      echo "Server PID changed: $OLD_SERVER_PID -> $NEW_SERVER_PID"
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Server restart complete - health check passed"
    exit 0
  fi
  sleep 1
done

echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: Server running but not responding at $SERVER_URL"
echo "Server restart complete (with warnings)"
