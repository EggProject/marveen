#!/usr/bin/env bats
#
# BATS tests for scripts/lib/installer-ollama-discovery.sh. The library is
# sourced (not run), and the discovered OLLAMA_URL / INSTALLER_OLLAMA_*
# env vars are asserted after each scripted stdin run. Coverage is
# measured by the existing installer-provider-prompt-coverage.test.sh
# contract script (extended below).

setup() {
  LIB="$BATS_TEST_DIRNAME/../lib/installer-ollama-discovery.sh"
  source "$LIB"
  # Silence library output during tests.
  _installer_log_info() { :; }
  _installer_log_warn() { :; }
  # Default: ollama not reachable (BATS doesn't have curl to a real server).
  _installer_curl() { return 1; }
  # Default: install hook is a no-op stub; per-test overrides record calls.
  _installer_install_ollama() { return 1; }
  # Per-test call counter that survives the $(...) subshell boundary.
  INSTALL_CALLS_FILE="$BATS_TEST_TMPDIR/install-calls"
  : > "$INSTALL_CALLS_FILE"
}

# Helper: drive the library with a piped input and capture the env vars
# the library sets, plus the install-hook call count.
run_discover() {
  installer_ollama_init
  installer_ollama_discover <<<"$1"
  echo "OLLAMA_URL=$OLLAMA_URL"
  echo "INSTALLER_OLLAMA_INSTALL=$INSTALLER_OLLAMA_INSTALL"
  echo "INSTALLER_OLLAMA_SKIP=$INSTALLER_OLLAMA_SKIP"
}

# ---------- Default probe (nothing reachable) -------------------------------

@test "nothing reachable, choice 1 (remote URL reachable) -> uses provided URL" {
  _installer_curl() {
    case "$1" in
      http://localhost*) return 1 ;;  # initial probe fails
      *192.168.0.10*) return 0 ;;      # remote URL probe succeeds
      *) return 1 ;;
    esac
  }
  out=$(run_discover $'1\nhttp://192.168.0.10:11434\n')
  echo "$out"
  [[ "$out" == *"OLLAMA_URL=http://192.168.0.10:11434"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_INSTALL=0"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=0"* ]]
}

@test "nothing reachable, choice 1 (remote URL unreachable) -> skip" {
  _installer_curl() { return 1; }
  out=$(run_discover $'1\nhttp://bad-host:11434\n')
  echo "$out"
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=1"* ]]
  [[ "$out" == *"OLLAMA_URL="* ]]
}

@test "nothing reachable, choice 2 (install) -> calls install hook" {
  _installer_install_ollama() {
    printf 'x' >> "$INSTALL_CALLS_FILE"
    return 0
  }
  out=$(run_discover $'2\n')
  echo "$out"
  calls=$(wc -c < "$INSTALL_CALLS_FILE" | tr -d ' ')
  [ "$calls" = "1" ]
  [[ "$out" == *"OLLAMA_URL=http://localhost:11434"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_INSTALL=0"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=0"* ]]
}

@test "nothing reachable, choice 2 (install fails) -> skip with empty URL" {
  _installer_install_ollama() { return 1; }
  out=$(run_discover $'2\n')
  echo "$out"
  [[ "$out" == *"OLLAMA_URL="* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=1"* ]]
}

@test "nothing reachable, choice 2 -> install hook is called exactly once" {
  _installer_install_ollama() {
    printf 'x' >> "$INSTALL_CALLS_FILE"
    return 0
  }
  run_discover $'2\n' >/dev/null
  calls=$(wc -c < "$INSTALL_CALLS_FILE" | tr -d ' ')
  [ "$calls" = "1" ]
}

@test "nothing reachable, choice 3 (skip) -> empty URL, SKIP=1" {
  out=$(run_discover $'3\n')
  echo "$out"
  [[ "$out" == *"OLLAMA_URL="* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=1"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_INSTALL=0"* ]]
}

@test "nothing reachable, invalid choice -> skip with warning" {
  out=$(run_discover $'99\n')
  echo "$out"
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=1"* ]]
}

# ---------- Local probe (initial probe succeeds) ----------------------------

@test "localhost reachable, no further prompt needed" {
  _installer_curl() { return 0; }
  out=$(run_discover "")
  echo "$out"
  [[ "$out" == *"OLLAMA_URL=http://localhost:11434"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_INSTALL=0"* ]]
  [[ "$out" == *"INSTALLER_OLLAMA_SKIP=0"* ]]
}

# ---------- installer_ollama_init contract ---------------------------------

@test "installer_ollama_init zeroes every env var" {
  OLLAMA_URL="dirty"
  INSTALLER_OLLAMA_INSTALL="dirty"
  INSTALLER_OLLAMA_SKIP="dirty"
  installer_ollama_init
  [ -z "$OLLAMA_URL" ]
  [ -z "$INSTALLER_OLLAMA_INSTALL" ]
  [ -z "$INSTALLER_OLLAMA_SKIP" ]
}

# ---------- Pre-seeded OLLAMA_URL honor -----------------------------------

@test "non-default OLLAMA_URL is probed first" {
  # run_discover zeroes OLLAMA_URL via init, so seed it AFTER init by
  # running install helper directly to set OLLAMA_URL, then discover.
  _installer_curl() {
    case "$1" in
      http://existing*) return 0 ;;
      *) return 1 ;;
    esac
  }
  installer_ollama_init
  OLLAMA_URL="http://existing:11434"
  installer_ollama_discover <<<""
  [ "$OLLAMA_URL" = "http://existing:11434" ]
  [ "$INSTALLER_OLLAMA_SKIP" = "0" ]
}

@test "pre-seeded OLLAMA_URL unreachable -> menu" {
  OLLAMA_URL="http://existing:11434"
  _installer_curl() { return 1; }
  _installer_install_ollama() {
    printf 'x' >> "$INSTALL_CALLS_FILE"
    return 0
  }
  out=$(run_discover $'2\n')
  echo "$out"
  calls=$(wc -c < "$INSTALL_CALLS_FILE" | tr -d ' ')
  [ "$calls" = "1" ]
  [[ "$out" == *"OLLAMA_URL=http://localhost:11434"* ]]
}

# ---------- Hook override contracts ---------------------------------------

@test "override _installer_curl with custom reachability" {
  _installer_curl() { return 0; }
  out=$(run_discover "")
  [[ "$out" == *"OLLAMA_URL=http://localhost:11434"* ]]
}

@test "override _installer_install_ollama receives no args" {
  install_args=""
  _installer_install_ollama() {
    install_args="$#"
    return 0
  }
  run_discover $'2\n' >/dev/null
  [ "$install_args" = "0" ]
}

# ---------- installer_ollama_wait_ready ---------------------------------

@test "wait_ready returns 0 when probe succeeds immediately" {
  _installer_curl() { return 0; }
  OLLAMA_URL="http://x:11434"
  installer_ollama_wait_ready 1
}

@test "wait_ready returns 1 when probe never succeeds" {
  _installer_curl() { return 1; }
  OLLAMA_URL="http://x:11434"
  run installer_ollama_wait_ready 1
  [ "$status" -eq 1 ]
}

@test "wait_ready invokes _installer_start_ollama hook when defined" {
  _installer_curl() { return 1; }
  _installer_start_ollama() {
    printf 'x' >> "$INSTALL_CALLS_FILE"
    return 0
  }
  OLLAMA_URL="http://x:11434"
  run installer_ollama_wait_ready 1
  [ "$status" -eq 1 ]
  calls=$(wc -c < "$INSTALL_CALLS_FILE" | tr -d ' ')
  [ "$calls" = "1" ]
}