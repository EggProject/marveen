#!/bin/bash
# installer-push-config.test.sh
#
# Unit tests for scripts/lib/installer-push-config.sh. The helper talks to
# the dashboard HTTP API via curl + Bearer token; here we mock curl with a
# shim that records calls into per-endpoint log files and lets each test
# script the response (200 / 401 / network failure).

set -u

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

INSTALL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
HELPER="$INSTALL_DIR/scripts/lib/installer-push-config.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  \033[32mPASS\033[0m %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  \033[31mFAIL\033[0m %s\n' "$1"; }
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"
  else fail "$1 (expected '$2', got '$3')"
  fi
}

# --- Build a mock /usr/bin/curl replacement ----------------------------------
#
# Usage: the test sets MOCK_CURL_RESPONSE_<status>_<endpoint> env vars to
# pick what the shim returns. The shim always logs the full HTTP request
# (method + url + body) to $MOCK_CURL_LOG so assertions can read it.
MOCK_BIN="$TMPDIR_BASE/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/curl" <<'SHIM'
#!/bin/bash
# mock curl shim: writes every arg verbatim to $MOCK_CURL_LOG, separating
# args with the unit-separator character (0x1F) so the log is machine-
# parseable even when arg values contain spaces (Authorization header,
# JSON body with spaces). Exits with $MOCK_CURL_EXIT (default 0). The
# response body is $MOCK_CURL_BODY (default empty).
{
  printf 'CALL'
  for arg in "$@"; do
    printf '\x1f%s' "$arg"
  done
  printf '\n'
} >> "$MOCK_CURL_LOG"
printf '%s' "${MOCK_CURL_BODY:-}"
exit "${MOCK_CURL_EXIT:-0}"
SHIM
chmod +x "$MOCK_BIN/curl"

# Helper: run installer_push_provider_config / installer_wait_for_dashboard
# against a fresh $INSTALL_DIR sandbox with a pre-seeded dashboard token.
# Usage: run_helper <test-name> <func-name>
# The caller-provided env vars (PROVIDER_VAULT_ID etc.) are exported so the
# helper sees them. The mock curl shim is on PATH for the duration.
run_helper() {
  local desc="$1"
  local func="$2"
  local fake_root="$TMPDIR_BASE/fake-$desc"
  mkdir -p "$fake_root/store"
  printf 'fake-token-deadbeef\n' > "$fake_root/store/.dashboard-token"
  (
    export INSTALL_DIR="$fake_root"
    export WEB_PORT=3420
    export MOCK_CURL_LOG="$TMPDIR_BASE/curl-$desc.log"
    export PATH="$MOCK_BIN:$PATH"
    # Re-export every PROVIDER_* var so the helper sees them.
    [ -n "${PROVIDER_VAULT_ID:-}" ]     && export PROVIDER_VAULT_ID
    [ -n "${PROVIDER_VAULT_LABEL:-}" ]  && export PROVIDER_VAULT_LABEL
    [ -n "${PROVIDER_VAULT_VALUE:-}" ]  && export PROVIDER_VAULT_VALUE
    [ -n "${PROVIDER_BASE_URL_KEY:-}" ] && export PROVIDER_BASE_URL_KEY
    [ -n "${PROVIDER_BASE_URL_VALUE:-}" ] && export PROVIDER_BASE_URL_VALUE
    [ -n "${MOCK_CURL_EXIT:-}" ]        && export MOCK_CURL_EXIT
    [ -n "${MOCK_CURL_BODY:-}" ]        && export MOCK_CURL_BODY
    rm -f "$MOCK_CURL_LOG"
    # shellcheck disable=SC1090
    source "$HELPER"
    "$func"
  )
}

echo
echo "=== installer-push-config.sh ==="

# Test 1: success path -- both Vault and settings POSTs return 0
PROVIDER_VAULT_ID="MINIMAX_API_KEY"
PROVIDER_VAULT_LABEL="MiniMax API key"
PROVIDER_VAULT_VALUE="sk-mm-test-1234"
PROVIDER_BASE_URL_KEY="MINIMAX_BASE_URL"
PROVIDER_BASE_URL_VALUE="https://api.minimax.io/anthropic"
run_helper "success" installer_push_provider_config
rc=$?
assert_eq "success: returns 0" "0" "$rc"

vault_call=$(grep -c 'http://127.0.0.1:3420/api/vault' "$TMPDIR_BASE/curl-success.log" || true)
settings_call=$(grep -c 'http://127.0.0.1:3420/api/settings' "$TMPDIR_BASE/curl-success.log" || true)
assert_eq "success: 1 vault POST" "1" "$vault_call"
assert_eq "success: 1 settings POST" "1" "$settings_call"

# The full call line is "CALL\x1f<arg1>\x1f<arg2>..." with the unit
# separator (0x1F) between args. Split on 0x1F to recover the verbatim args
# including those that contain spaces.
extract_arg_after() {
  # extract_arg_after <log-file> <line-nr> <flag-arg>
  python3 - "$@" <<'PY'
import sys
path, line_nr_s, flag = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    line_nr = int(line_nr_s)
except ValueError:
    sys.exit(0)
try:
    with open(path) as f:
        lines = f.readlines()
except FileNotFoundError:
    sys.exit(0)
if line_nr < 1 or line_nr > len(lines):
    sys.exit(0)
parts = lines[line_nr - 1].rstrip('\n').split('\x1f')
for i, p in enumerate(parts):
    if p == flag and i + 1 < len(parts):
        print(parts[i + 1])
        sys.exit(0)
PY
}

vault_body=$(extract_arg_after "$TMPDIR_BASE/curl-success.log" 1 "-d")
expected_vault='{"id":"MINIMAX_API_KEY","label":"MiniMax API key","value":"sk-mm-test-1234"}'
assert_eq "success: vault body has correct id/label/value" "$expected_vault" "$vault_body"

# The Authorization header value is its own arg in the call (not "-H VALUE"),
# so grep for the full value as-is.
if ! grep -q 'Authorization: Bearer fake-token-deadbeef' "$TMPDIR_BASE/curl-success.log"; then
  fail "success: vault uses Bearer token"
else
  pass "success: vault uses Bearer token"
fi

settings_body=$(extract_arg_after "$TMPDIR_BASE/curl-success.log" 2 "-d")
expected_settings='{"key":"MINIMAX_BASE_URL","value":"https://api.minimax.io/anthropic","actor":"installer"}'
assert_eq "success: settings body has key/value/actor" "$expected_settings" "$settings_body"

# Test 2: Vault-only path (DeepSeek, no base URL setting)
unset PROVIDER_BASE_URL_KEY PROVIDER_BASE_URL_VALUE
run_helper "vault-only" installer_push_provider_config
rc=$?
assert_eq "vault-only: returns 0" "0" "$rc"
vault_count=$(grep -c 'http://127.0.0.1:3420/api/vault' "$TMPDIR_BASE/curl-vault-only.log" || true)
settings_count=$(grep -c 'http://127.0.0.1:3420/api/settings' "$TMPDIR_BASE/curl-vault-only.log" || true)
vault_count=${vault_count:-0}
settings_count=${settings_count:-0}
assert_eq "vault-only: 1 vault POST" "1" "$vault_count"
assert_eq "vault-only: 0 settings POST" "0" "$settings_count"

# Test 3: Settings-only path (Ollama, no Vault)
unset PROVIDER_VAULT_ID PROVIDER_VAULT_LABEL PROVIDER_VAULT_VALUE
PROVIDER_BASE_URL_KEY="OLLAMA_URL"
PROVIDER_BASE_URL_VALUE="http://localhost:11434"
run_helper "settings-only" installer_push_provider_config
rc=$?
assert_eq "settings-only: returns 0" "0" "$rc"
vault_count=$(grep -c 'http://127.0.0.1:3420/api/vault' "$TMPDIR_BASE/curl-settings-only.log" || true)
settings_count=$(grep -c 'http://127.0.0.1:3420/api/settings' "$TMPDIR_BASE/curl-settings-only.log" || true)
vault_count=${vault_count:-0}
settings_count=${settings_count:-0}
assert_eq "settings-only: 0 vault POSTs" "0" "$vault_count"
assert_eq "settings-only: 1 settings POST" "1" "$settings_count"

# Test 4: no inputs set -> push is a no-op success
unset PROVIDER_VAULT_ID PROVIDER_VAULT_LABEL PROVIDER_VAULT_VALUE
unset PROVIDER_BASE_URL_KEY PROVIDER_BASE_URL_VALUE
run_helper "noop" installer_push_provider_config
rc=$?
assert_eq "noop: returns 0 with no inputs" "0" "$rc"
log_lines=$(wc -l < "$TMPDIR_BASE/curl-noop.log" 2>/dev/null || echo 0)
assert_eq "noop: 0 curl calls" "0" "$log_lines"

# Test 5: Vault 401 -> push fails
PROVIDER_VAULT_ID="MINIMAX_API_KEY"
PROVIDER_VAULT_LABEL="MiniMax API key"
PROVIDER_VAULT_VALUE="sk-mm-test-1234"
unset PROVIDER_BASE_URL_KEY PROVIDER_BASE_URL_VALUE
MOCK_CURL_EXIT=22 run_helper "vault-401" installer_push_provider_config
rc=$?
assert_eq "vault-401: returns 1" "1" "$rc"

# Test 6: settings 401 -> push fails
PROVIDER_BASE_URL_KEY="MINIMAX_BASE_URL"
PROVIDER_BASE_URL_VALUE="https://api.minimax.io/anthropic"
unset PROVIDER_VAULT_ID PROVIDER_VAULT_LABEL PROVIDER_VAULT_VALUE
MOCK_CURL_EXIT=22 run_helper "settings-401" installer_push_provider_config
rc=$?
assert_eq "settings-401: returns 1" "1" "$rc"

# Test 7: missing dashboard token -> push fails immediately
fake_root="$TMPDIR_BASE/fake-missing-token"
mkdir -p "$fake_root/store"
# Deliberately do NOT seed .dashboard-token
(
  unset MOCK_CURL_LOG
  export INSTALL_DIR="$fake_root"
  export WEB_PORT=3420
  export PROVIDER_VAULT_ID="X"
  export PROVIDER_VAULT_VALUE="Y"
  export PATH="$MOCK_BIN:$PATH"
  source "$HELPER"
  installer_push_provider_config
)
rc=$?
assert_eq "missing-token: returns 1" "1" "$rc"

# Test 8: installer_wait_for_dashboard succeeds when /api/settings answers
fake_root="$TMPDIR_BASE/fake-wait-ok"
mkdir -p "$fake_root/store"
printf 'fake-token\n' > "$fake_root/store/.dashboard-token"
(
  export INSTALL_DIR="$fake_root"
  export WEB_PORT=3420
  export MOCK_CURL_EXIT=0
  export MOCK_CURL_LOG="$TMPDIR_BASE/curl-wait-ok.log"
  rm -f "$MOCK_CURL_LOG"
  export PATH="$MOCK_BIN:$PATH"
  source "$HELPER"
  installer_wait_for_dashboard
)
rc=$?
assert_eq "wait-ok: returns 0 on immediate 200" "0" "$rc"

# Test 9: installer_wait_for_dashboard fails when token file is absent
fake_root="$TMPDIR_BASE/fake-wait-no-token"
mkdir -p "$fake_root/store"
(
  export INSTALL_DIR="$fake_root"
  export WEB_PORT=3420
  export PATH="$MOCK_BIN:$PATH"
  source "$HELPER"
  installer_wait_for_dashboard
)
rc=$?
assert_eq "wait-no-token: returns 1" "1" "$rc"

echo
echo "Results: $PASS pass, $FAIL fail"
exit "$FAIL"