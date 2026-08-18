#!/bin/sh
set -eu

UNIT="placegame-daily-automation"
WORLD_BOSS_UNIT="placegame-world-boss-automation"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_PATH="$SYSTEMD_DIR/$UNIT.service"
TIMER_PATH="$SYSTEMD_DIR/$UNIT.timer"
WORLD_BOSS_SERVICE_PATH="$SYSTEMD_DIR/$WORLD_BOSS_UNIT.service"
NODE_BIN=$(command -v node || true)

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now "$UNIT.timer" 2>/dev/null || true
  systemctl --user disable --now "$WORLD_BOSS_UNIT.service" 2>/dev/null || true
  rm -f "$SERVICE_PATH" "$TIMER_PATH" "$WORLD_BOSS_SERVICE_PATH"
  systemctl --user daemon-reload
  echo "Removed $UNIT"
  exit 0
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js is not installed or is not in PATH." >&2
  exit 1
fi

NODE_MAJOR=$($NODE_BIN -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node.js 24 or newer is required." >&2
  exit 1
fi

case "$PROJECT_DIR$NODE_BIN" in
  *%*|*'|'*|*'&'*|*\"*|*\\*|*\$*)
    echo "Project and Node paths contain characters unsupported by this installer." >&2
    exit 1
    ;;
esac

if [ ! -f "$PROJECT_DIR/.placegame-accounts.local.json" ]; then
  echo "Missing $PROJECT_DIR/.placegame-accounts.local.json" >&2
  exit 1
fi
chmod 600 "$PROJECT_DIR/.placegame-accounts.local.json"
mkdir -p "$SYSTEMD_DIR" "$PROJECT_DIR/.placegame-logs"
chmod 700 "$PROJECT_DIR/.placegame-logs"

umask 077
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__PROJECT__|$PROJECT_DIR|g" \
  "$SCRIPT_DIR/linux-systemd.service.template" > "$SERVICE_PATH"
sed \
  -e "s|__NODE__|$NODE_BIN|g" \
  -e "s|__PROJECT__|$PROJECT_DIR|g" \
  "$SCRIPT_DIR/linux-world-boss-systemd.service.template" > "$WORLD_BOSS_SERVICE_PATH"
cp "$SCRIPT_DIR/linux-systemd.timer.template" "$TIMER_PATH"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT.timer"
systemctl --user enable --now "$WORLD_BOSS_UNIT.service"
systemctl --user start "$UNIT.service"
echo "Installed $UNIT.timer and $WORLD_BOSS_UNIT.service. Inspect with: systemctl --user status $WORLD_BOSS_UNIT.service"
