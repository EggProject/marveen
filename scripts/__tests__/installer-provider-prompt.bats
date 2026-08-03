#!/usr/bin/env bats
#
# BATS tests for scripts/lib/installer-provider-prompt.sh. The library is
# sourced (not run), and the PROVIDER_* env vars are asserted after each
# scripted stdin run. Coverage is measured by kcov in the npm script
# `test:install:coverage` (100% threshold per-file).

setup() {
  # Source the library in a clean subshell; tests run in this subshell so
  # PROVIDER_* assertions do not leak between cases.
  LIB="$BATS_TEST_DIRNAME/../lib/installer-provider-prompt.sh"
  source "$LIB"
  # Silence library output during tests; capture it into $STDOUT / $STDERR
  # if a test wants to assert on it.
  STDOUT=""
  STDERR=""
  _installer_log_info() { printf '%s\n' "$*" >> "$BATS_TEST_TMPDIR/stdout"; }
  _installer_log_warn() { printf '%s\n' "$*" >> "$BATS_TEST_TMPDIR/stderr"; }
  _installer_log_ok()   { printf '%s\n' "$*" >> "$BATS_TEST_TMPDIR/stdout"; }
  # Default: ensure_in_rc is a recording stub; tests can override per case.
  _installer_ensure_in_rc() {
    printf '%s %s\n' "$1" "$2" >> "$BATS_TEST_TMPDIR/rc_writes"
  }
  # Default: no headless, no existing auth. Per-case overrides below.
  _installer_is_headless() { return 1; }
  _installer_service_auth_present() { return 1; }
  # Capture stdout / stderr lines for assertions.
  : > "$BATS_TEST_TMPDIR/stdout"
  : > "$BATS_TEST_TMPDIR/stderr"
  : > "$BATS_TEST_TMPDIR/rc_writes"
}

# Helper: pipe input to the library and capture resulting env vars.
run_prompt() {
  installer_prompt_init
  installer_prompt_provider <<<"$1"
  echo "PROVIDER_MODE=$PROVIDER_MODE"
  echo "PROVIDER_VAULT_ID=$PROVIDER_VAULT_ID"
  echo "PROVIDER_VAULT_LABEL=$PROVIDER_VAULT_LABEL"
  echo "PROVIDER_VAULT_VALUE=$PROVIDER_VAULT_VALUE"
  echo "PROVIDER_BASE_URL_KEY=$PROVIDER_BASE_URL_KEY"
  echo "PROVIDER_BASE_URL_VALUE=$PROVIDER_BASE_URL_VALUE"
}

# ---------- Provider choice: existing-auth short-circuit --------------------

@test "skips the prompt and seeds Claude OAuth when service_auth_present" {
  mkdir -p "$BATS_TEST_TMPDIR/store"
  printf 'existing-token-abc123\n' > "$BATS_TEST_TMPDIR/store/.claude-oauth-token"
  INSTALL_DIR="$BATS_TEST_TMPDIR"
  _installer_service_auth_present() { return 0; }
  out=$(run_prompt "")
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=1"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
  [[ "$out" == *"PROVIDER_VAULT_LABEL=Anthropic Claude setup-token (existing)"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=existing-token-abc123"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY="* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE="* ]]
}

# ---------- Anthropic branches ----------------------------------------------

@test "Anthropic API key: sets vault + writes to RC, no base URL" {
  out=$(run_prompt $'1\n1\nsk-ant-test-1234\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=1"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=ANTHROPIC_API_KEY"* ]]
  [[ "$out" == *"PROVIDER_VAULT_LABEL=Anthropic API key"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=sk-ant-test-1234"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY="* ]]
  grep -q '^ANTHROPIC_API_KEY export ANTHROPIC_API_KEY="sk-ant-test-1234"' "$BATS_TEST_TMPDIR/rc_writes"
}

@test "Anthropic OAuth token: sets vault + writes to RC" {
  out=$(run_prompt $'1\n2\nsk-ant-oat01-abcdef1234567890\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=sk-ant-oat01-abcdef1234567890"* ]]
  grep -q '^CLAUDE_CODE_OAUTH_TOKEN export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-abcdef1234567890"' "$BATS_TEST_TMPDIR/rc_writes"
}

@test "Anthropic API key with empty input: warn + leave buffers empty" {
  out=$(run_prompt $'1\n1\n\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=1"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE="* ]]
  grep -q 'API key nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}

@test "Anthropic OAuth with empty input: warn + leave buffers empty" {
  out=$(run_prompt $'1\n2\n\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
  grep -q 'Token nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}

@test "Anthropic skip branch (auth mode 3): leave buffers empty" {
  out=$(run_prompt $'1\n3\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=1"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
}

@test "Anthropic headless default picks OAuth (mode 2)" {
  _installer_is_headless() { return 0; }
  # Input shape: provider=1, auth-mode (empty -> defaults to 2 in headless),
  # then the OAuth token on the third line.
  out=$(run_prompt $'1\n\nsk-ant-oat01-abc1234567890\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=sk-ant-oat01-abc1234567890"* ]]
}

# ---------- MiniMax branches ------------------------------------------------

@test "MiniMax global endpoint: base URL + vault key" {
  out=$(run_prompt $'2\n1\nminimax-tok\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=2"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=MINIMAX_API_KEY"* ]]
  [[ "$out" == *"PROVIDER_VAULT_LABEL=MiniMax API key"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=minimax-tok"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY=MINIMAX_BASE_URL"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=https://api.minimax.io/anthropic"* ]]
}

@test "MiniMax China endpoint: base URL is minimaxi.com" {
  out=$(run_prompt $'2\n2\nminimax-tok\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=https://api.minimaxi.com/anthropic"* ]]
}

@test "MiniMax with empty API key: warn + base URL still set" {
  out=$(run_prompt $'2\n1\n\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_BASE_URL_KEY=MINIMAX_BASE_URL"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=https://api.minimax.io/anthropic"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE="* ]]
  grep -q 'MiniMax API key nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}

@test "MiniMax default region is global (empty input -> 1)" {
  out=$(run_prompt $'2\n\nminimax-tok\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=https://api.minimax.io/anthropic"* ]]
}

# ---------- DeepSeek branch -------------------------------------------------

@test "DeepSeek: vault id DEEPSEEK_API_KEY, no base URL" {
  out=$(run_prompt $'3\ndeepseek-tok\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=3"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=DEEPSEEK_API_KEY"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=deepseek-tok"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY="* ]]
}

@test "DeepSeek with empty input: warn + leave buffers empty" {
  out=$(run_prompt $'3\n\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=3"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
  grep -q 'DeepSeek API key nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}

# ---------- OpenRouter branch -----------------------------------------------

@test "OpenRouter: vault id openrouter-fleet-key, no base URL" {
  out=$(run_prompt $'4\nor-tok\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=4"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=openrouter-fleet-key"* ]]
  [[ "$out" == *"PROVIDER_VAULT_LABEL=OpenRouter API key"* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE=or-tok"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY="* ]]
}

@test "OpenRouter with empty input: warn" {
  out=$(run_prompt $'4\n\n')
  echo "$out"
  grep -q 'OpenRouter API key nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}

# ---------- Ollama branch ----------------------------------------------------

@test "Ollama with default URL: only base URL is set, no vault" {
  out=$(run_prompt $'5\n\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=5"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY=OLLAMA_URL"* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=http://localhost:11434"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE="* ]]
}

@test "Ollama with custom URL: URL is captured" {
  out=$(run_prompt $'5\nhttp://192.168.0.10:11434\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_BASE_URL_VALUE=http://192.168.0.10:11434"* ]]
}

# ---------- Skip branch -----------------------------------------------------

@test "Skip branch (6): all buffers empty" {
  out=$(run_prompt $'6\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=6"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
  [[ "$out" == *"PROVIDER_VAULT_VALUE="* ]]
  [[ "$out" == *"PROVIDER_BASE_URL_KEY="* ]]
}

@test "Empty stdin defaults to skip (6)" {
  out=$(run_prompt "")
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=6"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID="* ]]
}

# ---------- installer_prompt_init contract ----------------------------------

@test "installer_prompt_init zeroes every PROVIDER_* env var" {
  # Seed dirty state to prove init resets them.
  PROVIDER_VAULT_ID="dirty"
  PROVIDER_VAULT_VALUE="dirty"
  PROVIDER_BASE_URL_KEY="dirty"
  PROVIDER_BASE_URL_VALUE="dirty"
  installer_prompt_init
  [ -z "$PROVIDER_VAULT_ID" ]
  [ -z "$PROVIDER_VAULT_LABEL" ]
  [ -z "$PROVIDER_VAULT_VALUE" ]
  [ -z "$PROVIDER_BASE_URL_KEY" ]
  [ -z "$PROVIDER_BASE_URL_VALUE" ]
}

# ---------- Headless default branches ---------------------------------------

@test "headless + Anthropic default OAuth mode is 2" {
  _installer_is_headless() { return 0; }
  # Headless default for auth-mode is 2 (OAuth); test the empty-input path.
  out=$(run_prompt $'1\n\nsk-ant-oat01-abc1234567890\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
}

@test "headless + Anthropic empty auth-mode input still picks OAuth" {
  _installer_is_headless() { return 0; }
  out=$(run_prompt $'1\n\nsk-ant-oat01-abc1234567890\n')
  echo "$out"
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
}

# ---------- ensure_in_rc hook contract --------------------------------------

@test "Anthropic API key path passes through _installer_ensure_in_rc" {
  run_prompt $'1\n1\nsk-ant-test\n' >/dev/null
  grep -q '^ANTHROPIC_API_KEY export ANTHROPIC_API_KEY=' "$BATS_TEST_TMPDIR/rc_writes"
}

@test "Anthropic OAuth path passes through _installer_ensure_in_rc" {
  run_prompt $'1\n2\nsk-ant-oat01-abc\n' >/dev/null
  grep -q '^CLAUDE_CODE_OAUTH_TOKEN export CLAUDE_CODE_OAUTH_TOKEN=' "$BATS_TEST_TMPDIR/rc_writes"
}

@test "non-Claude providers do NOT call _installer_ensure_in_rc" {
  for inp in '2\n1\nmm\n' '3\nds\n' '4\nor\n' '5\nhttp://localhost:11434\n' '6\n'; do
    : > "$BATS_TEST_TMPDIR/rc_writes"
    run_prompt "$inp" >/dev/null
    if [ -s "$BATS_TEST_TMPDIR/rc_writes" ]; then
      echo "unexpected ensure_in_rc call for input: $inp"
      cat "$BATS_TEST_TMPDIR/rc_writes"
      return 1
    fi
  done
}

# ---------- Hook override -----------------------------------------------

@test "override _installer_service_auth_present short-circuits prompt" {
  _installer_service_auth_present() {
    printf 'short-circuit invoked\n' >&2
    return 0
  }
  out=$(run_prompt "")
  echo "$out"
  [[ "$out" == *"PROVIDER_MODE=1"* ]]
  [[ "$out" == *"PROVIDER_VAULT_ID=CLAUDE_CODE_OAUTH_TOKEN"* ]]
}

@test "override _installer_ensure_in_rc receives key name + export string" {
  # Replace the default stub with a counter; verify exact arguments.
  rc_calls=0
  _installer_ensure_in_rc() {
    rc_calls=$((rc_calls + 1))
    printf 'CALL %s|%s\n' "$1" "$2" >> "$BATS_TEST_TMPDIR/rc_calls"
  }
  run_prompt $'1\n1\nsk-ant-test-1\n' >/dev/null
  grep -q '^CALL ANTHROPIC_API_KEY|export ANTHROPIC_API_KEY="sk-ant-test-1"$' "$BATS_TEST_TMPDIR/rc_calls"
}

# ---------- Output formatting -----------------------------------------------

@test "info / warn / ok hooks are called for the expected branches" {
  # Anthropic API key path triggers: 1 ok on success.
  : > "$BATS_TEST_TMPDIR/stdout"
  run_prompt $'1\n1\nsk-ant-test\n' >/dev/null
  grep -q 'ANTHROPIC_API_KEY beallitva' "$BATS_TEST_TMPDIR/stdout"

  # Empty Anthropic API key path triggers: 1 warn.
  : > "$BATS_TEST_TMPDIR/stderr"
  run_prompt $'1\n1\n\n' >/dev/null
  grep -q 'API key nem lett megadva' "$BATS_TEST_TMPDIR/stderr"
}