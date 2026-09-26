#!/bin/bash
# The `pnpm service:*` and `daemon:*` commands, run against this checkout's own
# systemd units and logs (see service-names.sh).

set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$PROJECT_DIR/scripts/service-names.sh"

case "${1:-}" in
  start)
    systemctl --user start "$DAEMON_UNIT" "$SERVER_UNIT"
    echo "Services started. Use pnpm service:status to check." ;;
  stop)                  systemctl --user stop "$SERVER_UNIT" "$DAEMON_UNIT" ;;
  restart)               systemctl --user restart "$SERVER_UNIT" ;;
  restart-full)          systemctl --user restart "$DAEMON_UNIT" "$SERVER_UNIT" ;;
  status)                systemctl --user status "$DAEMON_UNIT" "$SERVER_UNIT" --no-pager ;;
  logs)                  tail -f "$LATTICE_DIR/logs/daemon.log" "$LATTICE_DIR/logs/server.log" ;;
  logs-daemon)           tail -f "$LATTICE_DIR/logs/daemon.log" ;;
  logs-server)           tail -f "$LATTICE_DIR/logs/server.log" ;;
  daemon-stop)           systemctl --user stop "$DAEMON_UNIT" ;;
  daemon-journal)        journalctl --user -u "$DAEMON_UNIT" -n 50 --no-pager ;;
  daemon-journal-follow) journalctl --user -u "$DAEMON_UNIT" -f --no-pager ;;
  *)
    echo "Usage: scripts/service.sh start|stop|restart|restart-full|status|logs|logs-daemon|logs-server|daemon-stop|daemon-journal|daemon-journal-follow" >&2
    exit 1 ;;
esac
