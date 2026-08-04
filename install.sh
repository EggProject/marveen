#!/bin/bash
# Marveen telepítő wrapper.
# A packages/install/src/cli.ts-t futtatja közvetlenül bun-nal.
# Nincs npm fallback: a projekt csak bun workspace-et használ.
# A bináris dist/cli.js csak build után jön létre; ez a wrapper a
# forrást használja, így build nélkül is működik.
set -e
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
exec bun "$REPO_ROOT/packages/install/src/cli.ts" "$@"
