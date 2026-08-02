#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/dist" "$TMP/store"
cp "$ROOT/scripts/runtime-config.mjs" "$TMP/scripts/runtime-config.mjs"
cp "$ROOT/dist/config-resolution.js" "$TMP/dist/config-resolution.js"
cp "$ROOT/dist/config-registry.js" "$TMP/dist/config-registry.js"
cp "$ROOT/dist/paths.js" "$TMP/dist/paths.js"

printf '%s\n' '{"WEB_PORT":4567,"BOT_NAME":"Ada"}' > "$TMP/store/config-overrides.json"

[ "$(node "$TMP/scripts/runtime-config.mjs" --root "$TMP" get WEB_PORT)" = "4567" ]
[ "$(node "$TMP/scripts/runtime-config.mjs" --root "$TMP" get CHANNEL_PROVIDER)" = "telegram" ]
[ "$(node "$TMP/scripts/runtime-config.mjs" --root "$TMP" get-many BOT_NAME WEB_PORT)" = '{"BOT_NAME":"Ada","WEB_PORT":4567}' ]

if node "$TMP/scripts/runtime-config.mjs" --root "$TMP" get UNKNOWN >/dev/null 2>&1; then
  echo "unknown key unexpectedly succeeded" >&2
  exit 1
fi

echo "runtime-config bridge: PASS"
