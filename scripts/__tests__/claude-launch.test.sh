#!/bin/bash
# Contract tests for scripts/claude-launch.sh.
#
# Pins the bash + jq shim's byte-equivalent output to the TS builder
# (src/web/claude-launch.ts) across all 12 site fixtures, plus branch
# coverage for jq-missing, missing-required-field, model `[1m]`,
# OAuth-via-$(cat), pluginId with embedded quotes, mcpBatch discriminator,
# tmuxServerPrep ordering, and login-shell wrapping.
#
# Run: bash scripts/__tests__/claude-launch.test.sh
#
# Mechanism: tests set CLAUDE_LAUNCH_DRY_RUN=1 so the shim prints each tmux
# invocation as `tmux <args joined>` lines on stdout. The MAIN invocation is
# always the LAST line; tmuxServerPrep steps come BEFORE it.

set -u

PASS=0; FAIL=0
pass() { PASS=$((PASS + 1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
assert_eq() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi; }

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SHIM="$INSTALL_DIR/scripts/claude-launch.sh"
FIXTURES_DIR="$INSTALL_DIR/src/__tests__/__fixtures__/claude-launch"
TMPDIR_="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_"' EXIT

# Write a JSON spec to $1 using the inline JSON in $2 (no jq templating needed).
write_spec() {
  local path="$1" body="$2"
  printf '%s\n' "$body" > "$path"
}

# Run the shim in dry-run mode, return stdout. Spec file in $1.
run_shim() {
  CLAUDE_LAUNCH_DRY_RUN=1 bash "$SHIM" "$1" 2>/dev/null
}

# Run the shim in dry-run mode, return stderr. For testing the jq guard.
run_shim_stderr() {
  CLAUDE_LAUNCH_DRY_RUN=1 bash "$SHIM" "$1" 2>&1 >/dev/null
}

# Run the shim in dry-run mode, return exit code.
run_shim_exit() {
  CLAUDE_LAUNCH_DRY_RUN=1 bash "$SHIM" "$1" >/dev/null 2>&1
  echo $?
}

# Strip the `tmux ` prefix from a dry-run line (reads stdin).
strip_tmux_prefix() {
  local s
  s="$(cat)"
  printf '%s' "${s#tmux }"
}

# Get the LAST dry-run line (the main invocation), with `tmux ` prefix.
last_invocation() {
  printf '%s\n' "$1" | tail -1
}

echo "claude-launch shim tests"
echo "========================"

# ---------------------------------------------------------------------------
# (1) jq missing -> exit 2, error to stderr
# ---------------------------------------------------------------------------
echo ""
echo "(1) jq missing"
# Build a PATH that has NO jq. Invoke bash via its absolute path so PATH-stripping
# doesn't kill the test runner itself.
EMPTY_PATH="$TMPDIR_/empty"
mkdir -p "$EMPTY_PATH"
HAVE_JQ="$(PATH="$EMPTY_PATH" command -v jq || true)"
BASH_ABS="$(command -v bash)"
if [ -z "$HAVE_JQ" ] && [ -n "$BASH_ABS" ]; then
  SPEC="$TMPDIR_/jq-spec.json"
  write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/c","cwd":"/","host":{"kind":"local"}}'
  EXIT=$(PATH="$EMPTY_PATH" "$BASH_ABS" "$SHIM" "$SPEC" 2>/dev/null; echo $?)
  ERR=$(PATH="$EMPTY_PATH" "$BASH_ABS" "$SHIM" "$SPEC" 2>&1 >/dev/null)
  if [ "$EXIT" = "2" ] && printf '%s' "$ERR" | grep -q "jq required"; then
    pass "jq missing: exit 2 + 'jq required' on stderr"
  else
    fail "jq missing: expected exit=2 + 'jq required' (got exit=$EXIT, err='$ERR')"
  fi
else
  fail "jq missing: pre-test path setup failed (jq='$HAVE_JQ' bash='$BASH_ABS')"
fi

# ---------------------------------------------------------------------------
# (2) Missing required field -> exit 3, error mentions the field name
# ---------------------------------------------------------------------------
echo ""
echo "(2) Missing required field"
SPEC="$TMPDIR_/bad-spec.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","cwd":"/","host":{"kind":"local"}}'
EXIT=$(run_shim_exit "$SPEC")
ERR=$(run_shim_stderr "$SPEC")
if [ "$EXIT" = "3" ] && printf '%s' "$ERR" | grep -q "missing required field: claudePath"; then
  pass "claudePath missing: exit 3 + field name in stderr"
else
  fail "missing required field: expected exit=3 + 'claudePath' (got exit=$EXIT, err='$ERR')"
fi

# ---------------------------------------------------------------------------
# (3-14) 12 byte-equality fixture tests. Build per-site spec, dry-run, diff.
# ---------------------------------------------------------------------------
echo ""
echo "(3-14) 12 site byte-equality fixtures"

# -- Helpers to construct per-site specs. Keep paths/staging identical to
#    fixtures: src/__tests__/__fixtures__/claude-launch/*.json --
TOKEN_PATH="'/Users/eggp/marveen/store/.claude-oauth-token'"
OAUTH_SPEC='{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"}'

# site-1: background one-shot — cwdAsCd=false (background-tasks inherits pane cwd)
SITE1='{
  "tmuxSubcommand":"newSession",
  "session":"bg-ABC12345",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "paneGeometry":{"cols":200,"rows":50},
  "cwdAsCd":false,
  "followups":{"extraFlags":"-p \"$BG_PROMPT\" --output-format text 2>&1","appendCmdSuffix":"; echo '"'"'___BG_DONE___'"'"'; sleep 5"}
}'

# site-2: stage1 fresh respawn-pane (linux + trailing, mcp triplet, oauth, plugin)
# Respawn-pane inherits the pane's existing cwd, so no `cd <cwd>` line is
# needed — the cwdAsCd=false flag SKIPS cd emission (matches TS site-2 spec).
SITE2='{
  "tmuxSubcommand":"respawnPane",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "mcpBatch":"always",
  "pathPreset":"linux",
  "pathTrailingInherit":true,
  "cwdAsCd":false
}'

# site-3: stage3 --continue recovery
SITE3='{
  "tmuxSubcommand":"respawnPane",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "continueSession":true,
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "mcpBatch":"always",
  "pathPreset":"linux",
  "pathTrailingInherit":true,
  "cwdAsCd":false
}'

# site-4: stage4 hard-restart (no --continue) — same as site-2 structure
SITE4='{
  "tmuxSubcommand":"respawnPane",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "mcpBatch":"always",
  "pathPreset":"linux",
  "pathTrailingInherit":true,
  "cwdAsCd":false
}'

# site-5: worker login-shell
SITE5='{
  "tmuxSubcommand":"newSession",
  "session":"worker-1",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen/agents/worker",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "isolatedConfigDir":"/Users/eggp/marveen/agents/worker/.channels-config",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "pathPreset":"login-shell"
}'

# site-6: subagent-local (macos + trailing, scrub, channelEnv, mcp batch, oauth)
SITE6='{
  "tmuxSubcommand":"newSession",
  "session":"agent-boni",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen/agents/boni",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "isolatedConfigDir":"/Users/eggp/marveen/agents/boni/.channels-config",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "channelEnv":{"provider":"telegram","stateDirVar":"TELEGRAM_STATE_DIR","stateDir":"/Users/eggp/marveen/agents/boni/.claude/channels/telegram"},
  "scrubChannelTokens":true,
  "mcpBatch":"always",
  "pathPreset":"macos",
  "pathTrailingInherit":true
}'

# site-7: subagent-ssh (bare claude, --continue, no plugin, no oauth, no trailing-needs-mac)
SITE7='{
  "tmuxSubcommand":"newSession",
  "session":"agent-geri",
  "claudePath":"claude",
  "cwd":"/home/user/work",
  "host":{"kind":"local"},
  "continueSession":true,
  "model":"MiniMax-M3[1m]",
  "pathPreset":"linux",
  "pathTrailingInherit":true
}'

# site-8: channels-primary (linux no trailing, sandbox+avx, mcp batch, channel, isolated, oauth, discord extra)
SITE8='{
  "tmuxSubcommand":"newSession",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "extraPluginIds":["discord@claude-plugins-official"],
  "channelEnv":{"provider":"telegram","stateDirVar":"TELEGRAM_STATE_DIR","stateDir":"/Users/eggp/marveen/.claude/channels/telegram"},
  "isolatedConfigDir":"/Users/eggp/marveen/.channels-config",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "mcpBatch":"always",
  "detectSandbox":true,
  "detectAvxLess":true,
  "pathPreset":"linux"
}'

# site-9: channels-eperm (same as 8 but cwd in /tmp, cwdAsTmuxC true)
SITE9='{
  "tmuxSubcommand":"newSession",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/tmp/marveen-channels-ABCDEF",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "channelEnv":{"provider":"telegram","stateDirVar":"TELEGRAM_STATE_DIR","stateDir":"/Users/eggp/marveen/.claude/channels/telegram"},
  "isolatedConfigDir":"/Users/eggp/marveen/.channels-config",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "mcpBatch":"always",
  "detectSandbox":true,
  "detectAvxLess":true,
  "pathPreset":"linux",
  "cwdAsTmuxC":true
}'

# site-10: watchdog (linux + trailing, scrub, channel, plugin, model)
SITE10='{
  "tmuxSubcommand":"newSession",
  "session":"agent-boni",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen/agents/boni",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "channelEnv":{"provider":"telegram","stateDirVar":"TELEGRAM_STATE_DIR","stateDir":"/Users/eggp/marveen/agents/boni/.claude/channels/telegram"},
  "scrubChannelTokens":true,
  "pathPreset":"linux",
  "pathTrailingInherit":true
}'

# site-11: channel-watchdog (linux no trailing, prompt guard only, iso, oauth, respawn)
SITE11='{
  "tmuxSubcommand":"respawnPane",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "isolatedConfigDir":"/Users/eggp/marveen/.channels-config",
  "fleetOauthToken":{"path":"/Users/eggp/marveen/store/.claude-oauth-token","read":"cat"},
  "promptSuggestionGuard":true,
  "pathPreset":"linux"
}'

# site-12: stuck-modal (linux no trailing, plain, respawn)
SITE12='{
  "tmuxSubcommand":"respawnPane",
  "session":"marveen-channels",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/Users/eggp/marveen",
  "host":{"kind":"local"},
  "model":"MiniMax-M3[1m]",
  "pluginId":"telegram@claude-plugins-official",
  "pathPreset":"linux"
}'

# Test a single site. $1=name, $2=spec, $3=fixture-file
test_site() {
  local name="$1" spec="$2" fixture="$3"
  local spec_path="$TMPDIR_/$name.json"
  write_spec "$spec_path" "$spec"
  local out last got exp
  out="$(run_shim "$spec_path")"
  last="$(last_invocation "$out")"
  got="$(printf '%s\n' "$last" | strip_tmux_prefix)"
  # The fixture's expectedTmuxArgs joined with a single space IS the expected
  # last dry-run line (sans the `tmux ` prefix).
  exp="$(jq -r '.expectedTmuxArgs | join(" ")' "$fixture")"
  if [ "$got" = "$exp" ]; then
    pass "byte-equality: $name matches fixture"
  else
    fail "byte-equality: $name differs from fixture"
    echo "    expected: $exp"
    echo "    got:      $got"
  fi
}

test_site site-1-background          "$SITE1"  "$FIXTURES_DIR/site-1-background.json"
test_site site-2-stage1               "$SITE2"  "$FIXTURES_DIR/site-2-stage1.json"
test_site site-3-stage3               "$SITE3"  "$FIXTURES_DIR/site-3-stage3.json"
test_site site-4-stage4               "$SITE4"  "$FIXTURES_DIR/site-4-stage4.json"
test_site site-5-worker               "$SITE5"  "$FIXTURES_DIR/site-5-worker.json"
test_site site-6-subagent-local       "$SITE6"  "$FIXTURES_DIR/site-6-subagent-local.json"
test_site site-7-subagent-ssh         "$SITE7"  "$FIXTURES_DIR/site-7-subagent-ssh.json"
test_site site-8-channels-primary     "$SITE8"  "$FIXTURES_DIR/site-8-channels-primary.json"
test_site site-9-channels-eperm       "$SITE9"  "$FIXTURES_DIR/site-9-channels-eperm.json"
test_site site-10-watchdog            "$SITE10" "$FIXTURES_DIR/site-10-watchdog.json"
test_site site-11-channel-watchdog    "$SITE11" "$FIXTURES_DIR/site-11-channel-watchdog.json"
test_site site-12-stuck-modal         "$SITE12" "$FIXTURES_DIR/site-12-stuck-modal.json"

# ---------------------------------------------------------------------------
# (15) Model with [1m] -> emitted cmd parses via bash -n, single-quote intact
# ---------------------------------------------------------------------------
echo ""
echo "(15) Model 'MiniMax-M3[1m]' survives glob/single-quote"
SPEC="$TMPDIR_/model-bracket.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp","host":{"kind":"local"},"model":"MiniMax-M3[1m]"}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
# bash -n parses the cmd as a command-string (here-document trick), then
# confirms `set -x` would expand it without glob-blowing the `[1m]`.
CMD_X="$(mktemp)"
printf '%s\n' "$GOT" > "$CMD_X"
# bash -n parses; the inner `$PATH` is not expanded at parse-time. Confirm
# the literal `[1m]` survives intact.
if bash -n "$CMD_X" 2>/dev/null && grep -qF "model 'MiniMax-M3[1m]'" "$CMD_X" && grep -qF -- "--dangerously-skip-permissions --model 'MiniMax-M3[1m]'" "$CMD_X"; then
  pass "model '[1m]': bash -n parses, single-quote intact, no glob"
else
  fail "model '[1m]': bash parse or single-quote preserved failed"
  echo "    got: $GOT"
fi
rm -f "$CMD_X"

# ---------------------------------------------------------------------------
# (16) Fleet OAuth token -> $(cat <path>) present, literal token absent
# ---------------------------------------------------------------------------
echo ""
echo "(16) Fleet OAuth token via \$(cat ...)"
# Use a token-shaped path with secret-looking chars inside
SPEC="$TMPDIR_/oauth-spec.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp","host":{"kind":"local"},"fleetOauthToken":{"path":"/tmp/secret-token-file-1234","read":"cat"}}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
if printf '%s' "$GOT" | grep -qF '$(cat '"'"'/tmp/secret-token-file-1234'"'"')'; then
  pass "OAuth: emitted \$(cat <single-quoted path>) form"
else
  fail "OAuth: expected \$(cat <path>) form (got '$GOT')"
fi
# No literal token string outside the $(cat ...) wrapper (sanity: 'secret' would
# be fine as it appears in the path; we instead look for an exposed
# CLAUDE_CODE_OAUTH_TOKEN="value" not wrapped in $(cat)).
if printf '%s' "$GOT" | grep -qE 'CLAUDE_CODE_OAUTH_TOKEN="[^$]'; then
  fail "OAuth: literal token string leaked (no \$(cat ...))"
else
  pass "OAuth: no literal-token emission"
fi

# ---------------------------------------------------------------------------
# (17) pluginId with embedded single-quote -> bash -n parses
# ---------------------------------------------------------------------------
echo ""
echo "(17) pluginId with embedded single-quote"
SPEC="$TMPDIR_/plugin-quote.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp","host":{"kind":"local"},"pluginId":"weird name with '\''s"}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
CMD_X="$(mktemp)"
printf '%s\n' "$GOT" > "$CMD_X"
if bash -n "$CMD_X" 2>/dev/null; then
  pass "pluginId with quote: bash -n parses emitted cmd"
else
  fail "pluginId with quote: bash -n rejected emitted cmd"
  echo "    got: $GOT"
  echo "    err: $(bash -n "$CMD_X" 2>&1)"
fi
rm -f "$CMD_X"

# ---------------------------------------------------------------------------
# (18) mcpBatch discriminator: channel-only + hasChannel -> triplet; otherwise no
# ---------------------------------------------------------------------------
echo ""
echo "(18) mcpBatch='channel-only' discriminator"
# A: channel-only + hasChannel (pluginId set) -> triplet
SPEC="$TMPDIR_/mcp-ch.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp","host":{"kind":"local"},"pluginId":"telegram@claude-plugins-official","mcpBatch":"channel-only"}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
if printf '%s' "$GOT" | grep -qF "MCP_SERVER_CONNECTION_BATCH_SIZE=10"; then
  pass "mcpBatch=channel-only + hasChannel -> triplet emitted"
else
  fail "mcpBatch=channel-only + hasChannel: triplet NOT emitted (got '$GOT')"
fi
# B: channel-only + !hasChannel -> no triplet
SPEC="$TMPDIR_/mcp-ch-no.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"s","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp","host":{"kind":"local"},"mcpBatch":"channel-only"}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
if printf '%s' "$GOT" | grep -qF "MCP_SERVER_CONNECTION_BATCH_SIZE=10"; then
  fail "mcpBatch=channel-only + !hasChannel: triplet SHOULD NOT be emitted"
else
  pass "mcpBatch=channel-only + !hasChannel -> no triplet"
fi

# ---------------------------------------------------------------------------
# (19) tmuxServerPrep ordering: start-server BEFORE set-environment -g
# ---------------------------------------------------------------------------
echo ""
echo "(19) tmuxServerPrep start-server precedes set-environment -g"
SPEC="$TMPDIR_/prep-spec.json"
write_spec "$SPEC" '{
  "tmuxSubcommand":"newSession",
  "session":"s",
  "claudePath":"/opt/homebrew/bin/claude",
  "cwd":"/tmp",
  "host":{"kind":"local"},
  "tmuxServerPrep":{
    "startServer":true,
    "unsetGlobalEnv":["FOO_TOKEN"],
    "setGlobalEnv":{"CLAUDE_CODE_OAUTH_TOKEN":"abc123","ANTHROPIC_API_KEY":"def456"}
  }
}'
OUT="$(run_shim "$SPEC")"
# find line numbers
SS_LINE="$(printf '%s\n' "$OUT" | grep -n 'start-server' | head -1 | cut -d: -f1)"
UNSET_LINE="$(printf '%s\n' "$OUT" | grep -n 'set-environment -g -u' | head -1 | cut -d: -f1)"
SET_LINE="$(printf '%s\n' "$OUT" | grep -n 'set-environment -g CLAUDE_CODE_OAUTH_TOKEN' | head -1 | cut -d: -f1)"
NEW_LINE="$(printf '%s\n' "$OUT" | grep -n 'new-session' | head -1 | cut -d: -f1)"
if [ -n "$SS_LINE" ] && [ -n "$UNSET_LINE" ] && [ -n "$SET_LINE" ] && [ -n "$NEW_LINE" ]; then
  if [ "$SS_LINE" -lt "$UNSET_LINE" ] && [ "$UNSET_LINE" -lt "$SET_LINE" ] && [ "$SET_LINE" -lt "$NEW_LINE" ]; then
    pass "ordering: start-server < unsetGlobalEnv < setGlobalEnv < new-session"
  else
    fail "ordering wrong: ss=$SS_LINE unset=$UNSET_LINE set=$SET_LINE new=$NEW_LINE"
  fi
else
  fail "ordering: missing one of start-server/unset/set/new-session lines (ss=$SS_LINE unset=$UNSET_LINE set=$SET_LINE new=$NEW_LINE)"
  echo "    out:"
  echo "$OUT" | sed 's/^/      /'
fi

# ---------------------------------------------------------------------------
# (20) pathPreset='login-shell' -> bash -lc wrapper in args
# ---------------------------------------------------------------------------
echo ""
echo "(20) pathPreset='login-shell' -> bash -lc wrapper"
SPEC="$TMPDIR_/login-shell-spec.json"
write_spec "$SPEC" '{"tmuxSubcommand":"newSession","session":"worker","claudePath":"/opt/homebrew/bin/claude","cwd":"/tmp/wd","host":{"kind":"local"},"pathPreset":"login-shell"}'
OUT="$(run_shim "$SPEC")"
LAST="$(last_invocation "$OUT")"
GOT="$(printf '%s\n' "$LAST" | strip_tmux_prefix)"
if printf '%s' "$GOT" | grep -qF 'bash -lc '; then
  pass "login-shell: 'bash -lc ' wrapper present in tmux args"
else
  fail "login-shell: 'bash -lc ' missing from tmux args (got '$GOT')"
fi
# Also confirm cwd was passed via -c flag (login-shell always passes -c)
if printf '%s' "$GOT" | grep -qF -- "-c /tmp/wd bash -lc"; then
  pass "login-shell: -c cwd precedes bash -lc"
else
  fail "login-shell: -c cwd not in correct position"
fi

# ---------------------------------------------------------------------------
echo ""
echo "========================"
TOTAL=$((PASS + FAIL))
echo "Results: $PASS/$TOTAL passed"
if [ "$FAIL" -gt 0 ]; then echo "FAILED: $FAIL tests"; exit 1; fi
echo "All tests passed."
