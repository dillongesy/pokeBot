#!/usr/bin/env bash
#
# Installs PokeDropper as a systemd service so it starts on boot and restarts
# if it crashes.
#
# Run it from the bot's folder as your normal user (not with sudo); it asks
# for your password when it needs root:
#
#   chmod +x install-service.sh
#   ./install-service.sh                 # service named "pokedropper"
#   ./install-service.sh mybot           # or pick a name
#
# Running as your own user matters: it is how the script finds the Node.js you
# installed (for example with nvm), which root cannot see.

set -euo pipefail

SERVICE_NAME="${1:-pokedropper}"
BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_USER="$(id -un)"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

fail() {
  echo "Error: $*" >&2
  exit 1
}

if [ "$(id -u)" -eq 0 ]; then
  fail "run this as your normal user, not root or sudo. It will ask for sudo when needed."
fi

# --- Node.js ----------------------------------------------------------------

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || fail "node not found. Install Node.js 22.5 or newer first (see README.md)."
NODE_BIN="$(readlink -f "$NODE_BIN")"

NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
if ! "$NODE_BIN" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit(major > 22 || (major === 22 && minor >= 5) ? 0 : 1);
'; then
  fail "Node.js $NODE_VERSION at $NODE_BIN is too old. Version 22.5 or newer is required."
fi

# --- Sanity checks ----------------------------------------------------------

[ -f "$BOT_DIR/index.js" ] || fail "index.js not found in $BOT_DIR. Run this from the bot's folder."
[ -f "$BOT_DIR/.env" ] || fail ".env not found. Copy .env.example to .env and fill it in first."
[ -d "$BOT_DIR/node_modules" ] || fail "node_modules not found. Run 'npm install' first."

if [ ! -f "$BOT_DIR/Data/Pokemon/index.json" ]; then
  echo "Warning: game data has not been imported yet. Run 'npm run import' before starting the bot." >&2
fi

# --- Write the unit ---------------------------------------------------------

echo "Installing ${SERVICE_NAME}.service"
echo "  folder: $BOT_DIR"
echo "  user:   $BOT_USER"
echo "  node:   $NODE_BIN (v$NODE_VERSION)"

# The bot reads .env itself, so no EnvironmentFile is needed. SIGINT lets it
# close the database cleanly on stop.
sudo tee "$UNIT_FILE" > /dev/null <<EOF
[Unit]
Description=PokeDropper Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${BOT_USER}
WorkingDirectory=${BOT_DIR}
ExecStart=${NODE_BIN} --no-warnings=ExperimentalWarning ${BOT_DIR}/index.js
Environment=NODE_ENV=production
Restart=always
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo
  echo "${SERVICE_NAME} is running."
else
  echo
  echo "${SERVICE_NAME} failed to start. Recent logs:" >&2
  sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
  exit 1
fi

cat <<EOF

Useful commands:
  sudo systemctl status ${SERVICE_NAME}      current state
  sudo journalctl -u ${SERVICE_NAME} -f      follow the logs
  sudo systemctl restart ${SERVICE_NAME}     restart (e.g. after git pull)
  sudo systemctl stop ${SERVICE_NAME}        stop

If you upgrade Node.js later, run this script again so the service uses the
new version.
EOF
