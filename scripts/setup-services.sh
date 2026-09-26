#!/bin/bash
# Setup systemd user services for Lattice Orchestrator
# Run this once to install the services

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
source "$SCRIPT_DIR/service-names.sh"
LATTICE_LOGS_DIR="$LATTICE_DIR/logs"

echo "Setting up Lattice systemd services..."
echo "Project directory: $PROJECT_DIR"

# Find Node.js path
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
    echo "Error: Node.js not found in PATH"
    exit 1
fi
echo "Node.js path: $NODE_PATH"

# Verify Node version
NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Create systemd user directory if it doesn't exist
mkdir -p "$SYSTEMD_USER_DIR"

# Create logs directory in canonical location
mkdir -p "$LATTICE_LOGS_DIR"
echo "Logs directory: $LATTICE_LOGS_DIR"

# Generate service files from templates
echo "Generating service files from templates..."

render() {
  sed -e "s|{{PROJECT_DIR}}|$PROJECT_DIR|g" \
      -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
      -e "s|{{CONFIG_DIR}}|$LATTICE_DIR|g" \
      -e "s|{{DAEMON_UNIT}}|$DAEMON_UNIT|g" \
      "$1"
}
render "$PROJECT_DIR/systemd/lattice-daemon.service.template" > "$SYSTEMD_USER_DIR/$DAEMON_UNIT.service"
render "$PROJECT_DIR/systemd/lattice-server.service.template" > "$SYSTEMD_USER_DIR/$SERVER_UNIT.service"

echo "  Created: $SYSTEMD_USER_DIR/$DAEMON_UNIT.service"
echo "  Created: $SYSTEMD_USER_DIR/$SERVER_UNIT.service"

# Reload systemd to pick up new services
systemctl --user daemon-reload

# Enable services to start on login
systemctl --user enable "$DAEMON_UNIT.service"
systemctl --user enable "$SERVER_UNIT.service"

# Enable lingering so services run without active login session
# (requires root or user must be in appropriate group)
if command -v loginctl &> /dev/null; then
  echo "Enabling lingering for user $USER..."
  loginctl enable-linger "$USER" 2>/dev/null || echo "Note: Could not enable linger (may need sudo)"
fi

# Setup log rotation
LOGROTATE_CONFIG_DIR="$HOME/.config/$SERVICE_PREFIX"
mkdir -p "$LOGROTATE_CONFIG_DIR"
sed -e "s|{{LOGS_DIR}}|$LATTICE_LOGS_DIR|g" "$PROJECT_DIR/config/logrotate.conf" > "$LOGROTATE_CONFIG_DIR/logrotate.conf"
echo "Log rotation config: $LOGROTATE_CONFIG_DIR/logrotate.conf"

# Add to user crontab if not already present
CRON_CMD="0 0 * * * /usr/sbin/logrotate -s $LATTICE_DIR/logrotate.state $LOGROTATE_CONFIG_DIR/logrotate.conf"
if ! crontab -l 2>/dev/null | grep -qF "$LOGROTATE_CONFIG_DIR/logrotate.conf"; then
  (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
  echo "Added log rotation to crontab (runs daily at midnight)"
else
  echo "Log rotation already in crontab"
fi

echo ""
echo "Services installed successfully!"
echo ""
echo "Log location: $LATTICE_LOGS_DIR"
echo "  - server.log: Express server logs"
echo "  - daemon.log: Process daemon logs"
echo ""
echo "Commands:"
echo "  Start:   systemctl --user start $DAEMON_UNIT $SERVER_UNIT"
echo "  Stop:    systemctl --user stop $SERVER_UNIT $DAEMON_UNIT"
echo "  Restart: systemctl --user restart $SERVER_UNIT"
echo "  Status:  systemctl --user status $DAEMON_UNIT $SERVER_UNIT"
echo "  Logs:    tail -f $LATTICE_LOGS_DIR/*.log"
echo ""
echo "Or use npm scripts:"
echo "  npm run service:start"
echo "  npm run service:stop"
echo "  npm run service:restart"
echo "  npm run service:status"
echo "  npm run service:logs"
