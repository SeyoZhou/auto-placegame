#!/bin/sh
set -eu

LABEL="cn.placegame.daily-automation"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/$LABEL.plist"
NODE_BIN=$(command -v node || true)

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed $LABEL"
  exit 0
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.js is not installed or is not in PATH." >&2
  exit 1
fi

case "$PROJECT_DIR$NODE_BIN" in
  *'|'*|*'&'*|*'<'*|*'>'*|*\"*|*\'*)
    echo "Project and Node paths contain characters unsupported by this installer." >&2
    exit 1
    ;;
esac

NODE_MAJOR=$($NODE_BIN -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 24 ]; then
  echo "Node.js 24 or newer is required." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/.placegame-accounts.local.json" ]; then
  echo "Missing $PROJECT_DIR/.placegame-accounts.local.json" >&2
  exit 1
fi
chmod 600 "$PROJECT_DIR/.placegame-accounts.local.json"
mkdir -p "$PLIST_DIR" "$PROJECT_DIR/.placegame-logs"
chmod 700 "$PROJECT_DIR/.placegame-logs"

PROJECT_XML=$(printf '%s' "$PROJECT_DIR" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g')
NODE_XML=$(printf '%s' "$NODE_BIN" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g')

umask 077
sed \
  -e "s|__NODE__|$NODE_XML|g" \
  -e "s|__PROJECT__|$PROJECT_XML|g" \
  "$SCRIPT_DIR/macos-launchd.plist.template" > "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "Installed $LABEL. Logs: $PROJECT_DIR/.placegame-logs/"
