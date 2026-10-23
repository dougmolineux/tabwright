#!/bin/sh
# Removes the native host, its manifest and the MCP registration. Keeps your config, token and
# profile unless --purge is given.
set -eu
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

case "$(uname)" in
  Darwin)
    CONF="$HOME/Library/Application Support/Tabwright"
    NMH="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/tabwright.json"
    LOGS="$HOME/Library/Logs/Tabwright"
    ;;
  *)
    CONF="${XDG_CONFIG_HOME:-$HOME/.config}/tabwright"
    NMH="$HOME/.mozilla/native-messaging-hosts/tabwright.json"
    LOGS="${XDG_STATE_HOME:-$HOME/.local/state}/tabwright"
    ;;
esac

rm -f "$NMH"
rm -rf "$HOME/.local/share/tabwright"
if command -v claude >/dev/null 2>&1; then
  claude mcp remove tabwright -s user >/dev/null 2>&1 || true
fi
if [ "$PURGE" -eq 1 ]; then
  rm -rf "$CONF" "$LOGS"
  echo "Removed the native host, MCP registration, config, profile and logs."
else
  echo "Removed the native host and MCP registration. Kept $CONF (use --purge to delete it)."
fi
echo "Remove the extension itself from about:addons."
