#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/scripts" "$TMP/dist/web" "$TMP/store"
cp "$ROOT/scripts/migrate-runtime-config.mjs" "$TMP/scripts/migrate-runtime-config.mjs"
for f in env config-registry config-resolution paths; do cp "$ROOT/dist/$f.js" "$TMP/dist/$f.js"; done
cp "$ROOT/dist/web/atomic-write.js" "$TMP/dist/web/atomic-write.js"

cat > "$TMP/.env" <<'ENV'
BOT_NAME=Ada
WEB_PORT=4567
TELEGRAM_BOT_TOKEN=secret-for-report-only
UNKNOWN_KEY=keep-me
ENV

report="$(node "$TMP/scripts/migrate-runtime-config.mjs" --root "$TMP" --dry-run)"
printf '%s' "$report" | grep -q 'TELEGRAM_BOT_TOKEN'
[ ! -f "$TMP/store/config-overrides.json" ]
[ ! -f "$TMP/.env.pre-runtime-config" ]

cat > "$TMP/.env" <<'ENV'
BOT_NAME=Ada
WEB_PORT=4567
UNKNOWN_KEY=keep-me
ENV
node "$TMP/scripts/migrate-runtime-config.mjs" --root "$TMP" >/dev/null

node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1])); if(f.BOT_NAME!=="Ada"||f.WEB_PORT!==4567)process.exit(1)' "$TMP/store/config-overrides.json"
grep -q '^UNKNOWN_KEY=keep-me$' "$TMP/.env"
! grep -q '^BOT_NAME=' "$TMP/.env"
[ -f "$TMP/.env.pre-runtime-config" ]

echo "runtime config migration: PASS"
