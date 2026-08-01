#!/usr/bin/env bash
# claude-launch.sh — bash + jq shim for ClaudeLaunchSpec.
#
# Mirror of src/web/claude-launch.ts. Reads a JSON spec from $1 and runs the
# tmux invocation. The output MUST be byte-equal to the TS builder for the same
# spec — the byte-equality contract is locked by tests in
# scripts/__tests__/claude-launch.test.sh.
#
# Usage:
#   bash claude-launch.sh <spec.json>
#
# Test mode: set CLAUDE_LAUNCH_DRY_RUN=1 to print the tmux invocations to
# stdout as `tmux <args>` lines (one per call, in invocation order) instead
# of actually running tmux. The main invocation is always the LAST line.

set -u

# -- jq guard --
command -v jq >/dev/null 2>&1 || { echo "jq required" >&2; exit 2; }

SPEC_FILE="${1:-./claude-launch-spec.json}"
[ -f "$SPEC_FILE" ] || { echo "spec file not found: $SPEC_FILE" >&2; exit 3; }

# -- POSIX single-quote, byte-equal to the TS shellSingleQuote helper --
# Pattern: every ' becomes '\''  (close-quote, escaped-quote, open-quote).
# Surround the result with ' on both sides. Canonical airtight quoting.
# The SQ variable holds the 4-char escape `'\''`; using it as the substitution
# replacement yields `'\''` for every `'` in the input.
shellSingleQuote() {
  local SQ="'\\''"
  printf "'%s'" "${1//\'/$SQ}"
}

require_field() {
  if [ -z "$1" ] || [ "$1" = "null" ]; then
    echo "missing required field: $2" >&2
    exit 3
  fi
}

# -- Read spec fields (jq -r '.field // <default>' pattern) --
TMUX_SUBCOMMAND="$(jq -r '.tmuxSubcommand // empty' "$SPEC_FILE")"
SESSION="$(jq -r '.session // empty' "$SPEC_FILE")"
CLAUDE_PATH="$(jq -r '.claudePath // empty' "$SPEC_FILE")"
CWD="$(jq -r '.cwd // empty' "$SPEC_FILE")"
HOST_KIND="$(jq -r '.host.kind // "local"' "$SPEC_FILE")"
HOST_SSH_TARGET="$(jq -r '.host.sshTarget // empty' "$SPEC_FILE")"

MODEL="$(jq -r '.model // empty' "$SPEC_FILE")"
DANGEROUSLY_SKIP_PERMISSIONS="$(jq -r 'if has("dangerouslySkipPermissions") then .dangerouslySkipPermissions else true end' "$SPEC_FILE")"
CONTINUE_SESSION="$(jq -r '.continueSession // false' "$SPEC_FILE")"
PLUGIN_ID="$(jq -r '.pluginId // empty' "$SPEC_FILE")"
EXTRA_PLUGIN_IDS_JSON="$(jq -c '.extraPluginIds // []' "$SPEC_FILE")"

ISOLATED_CONFIG_DIR="$(jq -r '.isolatedConfigDir // empty' "$SPEC_FILE")"
FLEET_OAUTH_PATH="$(jq -r '.fleetOauthToken.path // empty' "$SPEC_FILE")"
API_KEY_ENV="$(jq -r '.apiKey.env // empty' "$SPEC_FILE")"
API_KEY_VALUE="$(jq -r '.apiKey.value // empty' "$SPEC_FILE")"

CHANNEL_STATE_DIR_VAR="$(jq -r '.channelEnv.stateDirVar // empty' "$SPEC_FILE")"
CHANNEL_STATE_DIR="$(jq -r '.channelEnv.stateDir // empty' "$SPEC_FILE")"
CHANNEL_AUDIT_LOG="$(jq -r '.channelEnv.auditLogPath // empty' "$SPEC_FILE")"

MCP_BATCH="$(jq -r '.mcpBatch // "none"' "$SPEC_FILE")"
PROMPT_GUARD="$(jq -r '.promptSuggestionGuard // false' "$SPEC_FILE")"
SCRUB_CHANNEL_TOKENS="$(jq -r '.scrubChannelTokens // false' "$SPEC_FILE")"
DETECT_SANDBOX="$(jq -r '.detectSandbox // false' "$SPEC_FILE")"
DETECT_AVXLESS="$(jq -r '.detectAvxLess // false' "$SPEC_FILE")"

PATH_PRESET="$(jq -r '.pathPreset // "macos"' "$SPEC_FILE")"
PATH_TRAILING_INHERIT="$(jq -r '.pathTrailingInherit // false' "$SPEC_FILE")"

PANE_COLS="$(jq -r '.paneGeometry.cols // empty' "$SPEC_FILE")"
PANE_ROWS="$(jq -r '.paneGeometry.rows // empty' "$SPEC_FILE")"

# Note: `// true` with jq's alternative-operator treats `false` as falsy
# (returns the RHS), so an explicit `cwdAsCd:false` would be misread as true.
# Use `has(...)` to distinguish "missing" from "false".
CWD_AS_CD="$(jq -r 'if has("cwdAsCd") then .cwdAsCd else true end' "$SPEC_FILE")"
CWD_AS_TMUX_C="$(jq -r 'if has("cwdAsTmuxC") then .cwdAsTmuxC else false end' "$SPEC_FILE")"

START_SERVER="$(jq -r '.tmuxServerPrep.startServer // false' "$SPEC_FILE")"
UNSET_GLOBAL_ENV_JSON="$(jq -c '.tmuxServerPrep.unsetGlobalEnv // []' "$SPEC_FILE")"
SET_GLOBAL_ENV_JSON="$(jq -c '.tmuxServerPrep.setGlobalEnv // {}' "$SPEC_FILE")"

EXTRA_FLAGS="$(jq -r '.followups.extraFlags // empty' "$SPEC_FILE")"
APPEND_CMD_SUFFIX="$(jq -r '.followups.appendCmdSuffix // empty' "$SPEC_FILE")"

# -- Required fields --
require_field "$TMUX_SUBCOMMAND" "tmuxSubcommand"
require_field "$SESSION" "session"
require_field "$CLAUDE_PATH" "claudePath"
require_field "$CWD" "cwd"
require_field "$HOST_KIND" "host.kind"
if [ "$HOST_KIND" = "remote-ssh" ]; then
  require_field "$HOST_SSH_TARGET" "host.sshTarget"
  echo "remote-ssh hosts are not supported by the shell shim" >&2
  exit 3
fi

# -- hasChannel: presence of pluginId OR channelEnv -- SAME as TS
HAS_CHANNEL=false
[ -n "$PLUGIN_ID" ] && HAS_CHANNEL=true
[ -n "$CHANNEL_STATE_DIR" ] && HAS_CHANNEL=true

# -- PATH preset table, byte-equal to TS PATH_PRESETS --
case "$PATH_PRESET" in
  macos)
    PATH_PRESET_VALUE='/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin'
    ;;
  linux)
    PATH_PRESET_VALUE='/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin'
    ;;
  login-shell)
    PATH_PRESET_VALUE='$PATH'
    ;;
  *)
    echo "unknown pathPreset: $PATH_PRESET" >&2
    exit 3
    ;;
esac
TRAILING=""
[ "$PATH_TRAILING_INHERIT" = "true" ] && TRAILING=':$PATH'

# -- Build the cmd lines array (TS: lines = []; lines.push(...) calls) --
LINES=()
LINES+=("export PATH=\"${PATH_PRESET_VALUE}${TRAILING}\"")

if [ "$SCRUB_CHANNEL_TOKENS" = "true" ]; then
  LINES+=("unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN")
fi
if [ "$DETECT_SANDBOX" = "true" ]; then
  LINES+=("export IS_SANDBOX=1")
fi
if [ "$DETECT_AVXLESS" = "true" ]; then
  LINES+=("export DISABLE_AUTOUPDATER=1")
fi

# MCP batch / prompt guard — same conditional tree as TS
MCP_TRIPLET='export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000'
PROMPT_LINE='export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false'
case "$MCP_BATCH" in
  always)
    LINES+=("$MCP_TRIPLET")
    ;;
  channel-only)
    if [ "$HAS_CHANNEL" = "true" ]; then
      LINES+=("$MCP_TRIPLET")
    elif [ "$PROMPT_GUARD" = "true" ]; then
      LINES+=("$PROMPT_LINE")
    fi
    ;;
  none)
    if [ "$PROMPT_GUARD" = "true" ]; then
      LINES+=("$PROMPT_LINE")
    fi
    ;;
  *)
    echo "unknown mcpBatch: $MCP_BATCH" >&2
    exit 3
    ;;
esac

# channelEnv lines (state dir + optional slack audit log)
if [ -n "$CHANNEL_STATE_DIR" ] && [ -n "$CHANNEL_STATE_DIR_VAR" ]; then
  SQ_STATE_DIR="$(shellSingleQuote "$CHANNEL_STATE_DIR")"
  LINES+=("export ${CHANNEL_STATE_DIR_VAR}=${SQ_STATE_DIR}")
  if [ -n "$CHANNEL_AUDIT_LOG" ]; then
    SQ_AUDIT="$(shellSingleQuote "$CHANNEL_AUDIT_LOG")"
    LINES+=("export SLACK_AUDIT_LOG=${SQ_AUDIT}")
  fi
fi

# isolatedConfigDir
if [ -n "$ISOLATED_CONFIG_DIR" ]; then
  SQ_ISO="$(shellSingleQuote "$ISOLATED_CONFIG_DIR")"
  LINES+=("export CLAUDE_CONFIG_DIR=${SQ_ISO}")
fi

# fleetOauthToken: ALWAYS $(cat <single-quoted path>), NEVER literal token
if [ -n "$FLEET_OAUTH_PATH" ]; then
  SQ_OAUTH="$(shellSingleQuote "$FLEET_OAUTH_PATH")"
  LINES+=("export CLAUDE_CODE_OAUTH_TOKEN=\"\$(cat ${SQ_OAUTH})\"")
fi

# apiKey: only ANTHROPIC_API_KEY is permitted; quote the value as inert data.
if [ -n "$API_KEY_ENV" ] || [ -n "$API_KEY_VALUE" ]; then
  [ "$API_KEY_ENV" = "ANTHROPIC_API_KEY" ] || { echo "unsupported apiKey.env: $API_KEY_ENV" >&2; exit 3; }
  SQ_API_KEY="$(shellSingleQuote "$API_KEY_VALUE")"
  LINES+=("export ANTHROPIC_API_KEY=${SQ_API_KEY}")
fi

# cd line — only when pathPreset!='login-shell' AND cwdAsCd !== false
if [ "$PATH_PRESET" != "login-shell" ] && [ "$CWD_AS_CD" != "false" ]; then
  SQ_CWD="$(shellSingleQuote "$CWD")"
  LINES+=("cd ${SQ_CWD}")
fi

# -- Build claudeParts (TS: claudeParts = [claudePath, ...] with conditional pushes) --
CLAUDE_PARTS=()
CLAUDE_PARTS+=("$CLAUDE_PATH")
[ "$CONTINUE_SESSION" = "true" ] && CLAUDE_PARTS+=("--continue")
[ "$DANGEROUSLY_SKIP_PERMISSIONS" != "false" ] && CLAUDE_PARTS+=("--dangerously-skip-permissions")
if [ -n "$MODEL" ]; then
  SQ_MODEL="$(shellSingleQuote "$MODEL")"
  CLAUDE_PARTS+=("--model" "$SQ_MODEL")
fi

if [ -n "$PLUGIN_ID" ]; then
  # plugins = [pluginId, ...extraPluginIds].filter(Boolean)
  PLUGINS=("$PLUGIN_ID")
  while IFS= read -r p; do
    [ -n "$p" ] && PLUGINS+=("$p")
  done < <(printf '%s\n' "$EXTRA_PLUGIN_IDS_JSON" | jq -r '.[]')

  # --channels plugin:'<id>' ... — single shell-quoted entry per plugin
  CHANNELS_STR="--channels"
  for p in "${PLUGINS[@]}"; do
    SQ_P="$(shellSingleQuote "$p")"
    CHANNELS_STR="${CHANNELS_STR} plugin:${SQ_P}"
  done
  CLAUDE_PARTS+=("$CHANNELS_STR")
fi

if [ -n "$EXTRA_FLAGS" ]; then
  CLAUDE_PARTS+=("$EXTRA_FLAGS")
fi

# -- Join lines with ` && ` (TS: lines.filter(Boolean).join(' && ')) --
HEAD=""
for l in "${LINES[@]}"; do
  [ -z "$l" ] && continue
  if [ -z "$HEAD" ]; then HEAD="$l"; else HEAD="$HEAD && $l"; fi
done

# -- Join claudeParts with single space (TS: claudeParts.join(' ')) --
CLAUDE_STR=""
for p in "${CLAUDE_PARTS[@]}"; do
  if [ -z "$CLAUDE_STR" ]; then CLAUDE_STR="$p"; else CLAUDE_STR="$CLAUDE_STR $p"; fi
done

# Final cmd: head && claudeParts; appendCmdSuffix concatenated (NO && separator)
CMD="${HEAD} && ${CLAUDE_STR}"
if [ -n "$APPEND_CMD_SUFFIX" ]; then
  CMD="${CMD}${APPEND_CMD_SUFFIX}"
fi

# -- Build tmux args array (TS: args.push(...) sequences) --
TMUX_ARGS=()
case "$TMUX_SUBCOMMAND" in
  newSession)
    TMUX_ARGS+=("new-session" "-d" "-s" "$SESSION")
    if [ -n "$PANE_COLS" ] && [ -n "$PANE_ROWS" ]; then
      TMUX_ARGS+=("-x" "$PANE_COLS" "-y" "$PANE_ROWS")
    fi
    # login-shell wrapper (RETURN-equivalent: set a flag, skip the rest)
    if [ "$PATH_PRESET" = "login-shell" ]; then
      TMUX_ARGS+=("-c" "$CWD" "bash" "-lc" "$CMD")
      WRAPPED=true
    fi
    # cwdAsTmuxC (only when not login-shell — matches TS precedence)
    if [ "${WRAPPED:-}" != "true" ] && [ "$CWD_AS_TMUX_C" = "true" ]; then
      TMUX_ARGS+=("-c" "$CWD")
    fi
    if [ "${WRAPPED:-}" != "true" ]; then
      TMUX_ARGS+=("$CMD")
    fi
    ;;
  respawnPane)
    TMUX_ARGS+=("respawn-pane" "-k" "-t" "$SESSION" "$CMD")
    ;;
  *)
    echo "unknown tmuxSubcommand: $TMUX_SUBCOMMAND" >&2
    exit 3
    ;;
esac

# -- tmux call helper (real or dry-run) --
TMUX_BIN="$(command -v tmux)"
tmux_call() {
  local args=("$@")
  if [ "${CLAUDE_LAUNCH_DRY_RUN:-}" = "1" ]; then
    # Print `tmux <args joined by single space>` so tests can match diff -u.
    local first=1 out=""
    for a in "${args[@]}"; do
      if [ "$first" = 1 ]; then out="$a"; first=0; else out="$out $a"; fi
    done
    printf '%s\n' "tmux $out"
  else
    "$TMUX_BIN" "${args[@]}"
  fi
}

# -- tmuxServerPrep: start-server → unsetGlobalEnv → setGlobalEnv (TS order) --
if [ "$START_SERVER" = "true" ]; then
  tmux_call "start-server"
fi
if [ "$UNSET_GLOBAL_ENV_JSON" != "[]" ]; then
  while IFS= read -r v; do
    [ -n "$v" ] && tmux_call "set-environment" "-g" "-u" "$v"
  done < <(printf '%s\n' "$UNSET_GLOBAL_ENV_JSON" | jq -r '.[]')
fi
if [ "$SET_GLOBAL_ENV_JSON" != "{}" ]; then
  while IFS= read -r entry; do
    k="${entry%%	*}"
    v="${entry#*	}"
    [ -n "$k" ] && tmux_call "set-environment" "-g" "$k" "$v"
  done < <(printf '%s\n' "$SET_GLOBAL_ENV_JSON" | jq -r 'to_entries[] | "\(.key)	\(.value)"')
fi

# -- Main tmux invocation (always last) --
tmux_call "${TMUX_ARGS[@]}"

exit 0
