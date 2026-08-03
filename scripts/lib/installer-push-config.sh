#!/bin/bash
# installer-push-config.sh
#
# Shared helper for install-linux.sh and install-macos.sh: pushes the
# provider credential the operator typed at the provider-selection prompt
# into the running dashboard's Vault, and writes the provider-specific base
# URL setting into store/config-overrides.json. Both endpoints require a
# `DASHBOARD_TOKEN` that the dashboard creates on its first listener-bind
# (src/web/dashboard-auth.ts), so callers MUST wait for the dashboard to
# come up via installer_wait_for_dashboard before invoking the push.
#
# Inputs (all set by the caller):
#   $INSTALL_DIR           -- the deployment root (where store/ lives)
#   $WEB_PORT              -- dashboard port (default: 3420)
#   $PROVIDER_VAULT_ID     -- Vault secret id, e.g. MINIMAX_API_KEY (omit to skip)
#   $PROVIDER_VAULT_LABEL  -- human-readable label for the Vault entry
#   $PROVIDER_VAULT_VALUE  -- the secret value itself
#   $PROVIDER_BASE_URL_KEY -- settings key, e.g. MINIMAX_BASE_URL (omit to skip)
#   $PROVIDER_BASE_URL_VALUE
#
# Exits 0 on a fully-successful push (Vault + settings when both requested),
# 1 on any failure. Failures are non-fatal at the installer level (the
# operator can finish setup via the dashboard wizard).

set -u

installer_dashboard_base() {
  printf '%s' "http://127.0.0.1:${WEB_PORT:-3420}"
}

# Returns 0 if the dashboard /api/settings answers 2xx with the bearer token,
# 1 if it does not within the budget. Polls once per second up to 30s.
installer_wait_for_dashboard() {
  local i token base url
  for i in $(seq 1 30); do
    if [ ! -f "$INSTALL_DIR/store/.dashboard-token" ]; then
      sleep 1
      continue
    fi
    token=$(cat "$INSTALL_DIR/store/.dashboard-token" 2>/dev/null) || { sleep 1; continue; }
    [ -n "$token" ] || { sleep 1; continue; }
    base=$(installer_dashboard_base)
    url="$base/api/settings"
    if curl -sf -o /dev/null -H "Authorization: Bearer $token" "$url" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# Pushes the Vault entry (if $PROVIDER_VAULT_VALUE is set) and the base URL
# setting (if $PROVIDER_BASE_URL_KEY is set). Returns 0 only if every
# requested write succeeded.
installer_push_provider_config() {
  local token base auth vault_payload settings_payload

  [ -f "$INSTALL_DIR/store/.dashboard-token" ] || return 1
  token=$(cat "$INSTALL_DIR/store/.dashboard-token" 2>/dev/null) || return 1
  [ -n "$token" ] || return 1
  base=$(installer_dashboard_base)
  auth="Authorization: Bearer $token"

  if [ -n "${PROVIDER_VAULT_VALUE:-}" ] && [ -n "${PROVIDER_VAULT_ID:-}" ]; then
    vault_payload=$(printf '{"id":"%s","label":"%s","value":"%s"}' \
      "$PROVIDER_VAULT_ID" "${PROVIDER_VAULT_LABEL:-$PROVIDER_VAULT_ID}" "$PROVIDER_VAULT_VALUE")
    curl -sf -X POST "$base/api/vault" \
      -H "Content-Type: application/json" -H "$auth" \
      -d "$vault_payload" >/dev/null || return 1
  fi

  if [ -n "${PROVIDER_BASE_URL_KEY:-}" ] && [ -n "${PROVIDER_BASE_URL_VALUE:-}" ]; then
    settings_payload=$(printf '{"key":"%s","value":"%s","actor":"installer"}' \
      "$PROVIDER_BASE_URL_KEY" "$PROVIDER_BASE_URL_VALUE")
    curl -sf -X POST "$base/api/settings" \
      -H "Content-Type: application/json" -H "$auth" \
      -d "$settings_payload" >/dev/null || return 1
  fi

  return 0
}