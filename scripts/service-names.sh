# Sourced by the service scripts. Sets LATTICE_DIR to the config dir the server
# uses and names the systemd units after it: ~/.lattice-app gives
# lattice-app-server and lattice-app-daemon. The older npm release installs
# units called lattice-server and lattice-daemon; sharing those names would let
# either install stop, restart or overwrite the other's services.
# Expects PROJECT_DIR to be set.

LATTICE_DIR="$(cd "$PROJECT_DIR" && npx tsx scripts/print-config-dir.ts)"
SERVICE_PREFIX="$(basename "$LATTICE_DIR")"
SERVICE_PREFIX="${SERVICE_PREFIX#.}"
SERVER_UNIT="$SERVICE_PREFIX-server"
DAEMON_UNIT="$SERVICE_PREFIX-daemon"
