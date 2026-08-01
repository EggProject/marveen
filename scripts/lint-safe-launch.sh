#!/usr/bin/env bash
# lint:safe-launch: refuses launch code that embeds a literal OAuth token.
# The accepted form reads the token from its protected file at shell runtime:
#   export CLAUDE_CODE_OAUTH_TOKEN="$(cat <path>)"
# The `$(cat ...)` form keeps the secret out of argv, `ps`, and tmux command
# history. A literal-token emission is a CV-grade regression.
#
# Scope: every TS launch path that injects the OAuth token into a tmux command
# string (src/web/agent-process.ts, src/web/claude-launch.ts) and the bash
# shim that consumes the same spec (scripts/claude-launch.sh).
set -u

bad=$(grep -rnE '(^|[^A-Za-z0-9_-])export CLAUDE_CODE_OAUTH_TOKEN=' \
        src/web/agent-process.ts src/web/claude-launch.ts scripts/claude-launch.sh 2>/dev/null \
  | grep -Fv '$(cat' \
  || true)

if [ -n "$bad" ]; then
  printf '%s\n' "$bad" >&2
  echo 'refused: literal OAuth token emission outside $(cat ...) form' >&2
  exit 1
fi
exit 0
