#!/bin/bash
# Marveen - wrapper a marveen-install CLI-hez / Wrapper for the marveen-install CLI.
# Ha bun elérhető, a @marveen/install csomagot futtatja; egyébként npx-szel tölti le. / Uses bun if available, otherwise falls back to npx.
if command -v bun >/dev/null 2>&1; then exec bunx @marveen/install "$@"; else exec npx -y @marveen/install "$@"; fi
