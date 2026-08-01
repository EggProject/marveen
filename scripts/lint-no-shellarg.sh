#!/usr/bin/env bash
# lint:no-shellarg: refuses additional POSIX single-quote helper copies.
# shQuote in ssh-tmux.ts is the canonical implementation; the others listed
# below are legacy duplicates predating this gate and slated for removal.
# Catches BOTH the function-style definition (`function name ...` or
# `export function name ...`) and the alias-style declaration
# (`export const name = shQuote` / `export const name = shellEscape`).
set -u

bad=$(grep -rnE '^((export )?function|(export )?const) (shellSingleQuote|shQuote|shellEscape|shArg|posixQuote|sq)( |\(|$)' src/ 2>/dev/null \
  | grep -v 'src/web/ssh-tmux.ts' \
  | grep -v 'src/web/sanitize.ts' \
  | grep -v 'src/web/claude-launch.ts' \
  || true)

if [ -n "$bad" ]; then
  printf '%s\n' "$bad" >&2
  echo 'refused: new POSIX single-quote helper copy outside canonical locations' >&2
  exit 1
fi
