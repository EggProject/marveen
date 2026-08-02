#!/bin/bash
# Stop main agent services

INSTALL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib/runtime-config.sh
. "$INSTALL_DIR/scripts/lib/runtime-config.sh" || exit 1
runtime_config_init "$INSTALL_DIR" || exit 1
SLUG="$(runtime_config_get MAIN_AGENT_ID)"
BOT_NAME="$(runtime_config_get BOT_NAME)"
SLUG="${SLUG:-marveen}"

MARVEEN_LANG="$(cat "${INSTALL_DIR}/.lang" 2>/dev/null || echo hu)"
# shellcheck source=../install-lang.sh
source "${INSTALL_DIR}/install-lang.sh"

echo "${BOT_NAME:-Marveen} $(_t stop.stopping)"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.dashboard.plist" 2>/dev/null
  launchctl unload "$HOME/Library/LaunchAgents/com.${SLUG}.channels.plist" 2>/dev/null
elif [ "$OS" = "Linux" ]; then
  if pidof systemd >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    systemctl --user stop "${SLUG}-dashboard" "${SLUG}-channels" 2>/dev/null || true
  else
    for svc in dashboard channels; do
      pidfile="$INSTALL_DIR/store/${svc}.pid"
      if [ -f "$pidfile" ]; then
        pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null || true
        rm -f "$pidfile"
      fi
    done
  fi
fi

# Stop the main channels tmux session. Do not kill sub-agent sessions.
tmux kill-session -t "${SLUG}-channels" 2>/dev/null || true

echo "✓ ${BOT_NAME:-Marveen} $(_t stop.stopped)"
