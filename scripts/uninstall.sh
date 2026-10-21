#!/bin/sh
# Removes the native host, its manifest and the MCP registration. Keeps your config, token and
# profile unless --purge is given.
set -eu
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

case "$(uname)" in
  Darwin)
    CONF="$HOME/Library/Application Support/ClaudeBridge"
    NMH="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/claude_bridge.json"
    LOGS="$HOME/Library/Logs/ClaudeBridge"
    ;;
  *)
    CONF="${XDG_CONFIG_HOME:-$HOME/.config}/claude-bridge"
    NMH="$HOME/.mozilla/native-messaging-hosts/claude_bridge.json"
    LOGS="${XDG_STATE_HOME:-$HOME/.local/state}/claude-bridge"
    ;;
esac

rm -f "$NMH"
rm -rf "$HOME/.local/share/claude-bridge"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove firefox -s user >/dev/null 2>&1 || true
fi
if [ "$PURGE" -eq 1 ]; then
  rm -rf "$CONF" "$LOGS"
  echo "Removed the native host, MCP registration, config, profile and logs."
else
  echo "Removed the native host and MCP registration. Kept $CONF (use --purge to delete it)."
fi
echo "Remove the extension itself from about:addons."
