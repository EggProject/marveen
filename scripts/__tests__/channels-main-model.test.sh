#!/bin/bash
# Contract tests for canonical main-agent model resolution in scripts/channels.sh.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1 -- expected: $2, got: $3"; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${CHANNELS_BIN:-$INSTALL_DIR/scripts/channels.sh}"

expect_model() {
  local label="$1" overrides="$2" want="$3"
  local root got
  root="$(mktemp -d)"
  mkdir -p "$root/scripts/lib" "$root/dist" "$root/store"
  cp "$SRC" "$root/scripts/channels.sh"
  cp "$INSTALL_DIR/scripts/runtime-config.mjs" "$root/scripts/runtime-config.mjs"
  cp "$INSTALL_DIR/scripts/lib/runtime-config.sh" "$root/scripts/lib/runtime-config.sh"
  cp "$INSTALL_DIR/dist/config-resolution.js" "$root/dist/config-resolution.js"
  cp "$INSTALL_DIR/dist/config-registry.js" "$root/dist/config-registry.js"
  cp "$INSTALL_DIR/dist/paths.js" "$root/dist/paths.js"
  printf '%s\n' "$overrides" > "$root/store/config-overrides.json"
  got="$(bash "$root/scripts/channels.sh" --resolve-main-model 2>/dev/null | head -1)"
  rm -rf "$root"
  if [ "$got" = "$want" ]; then pass "$label"; else fail "$label" "$want" "$got"; fi
}

echo "channels.sh main-model resolution"

expect_model "registry default is used when no override exists" \
  '{}' 'claude-opus-4-8[1m]'

expect_model "canonical override wins over the registry default" \
  '{"DEFAULT_AGENT_MODEL":"claude-opus-5"}' 'claude-opus-5'

expect_model "bracketed suffix survives the canonical store" \
  '{"DEFAULT_AGENT_MODEL":"claude-opus-5[1m]"}' 'claude-opus-5[1m]'

echo
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
