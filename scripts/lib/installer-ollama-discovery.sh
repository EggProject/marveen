#!/bin/bash
# installer-ollama-discovery.sh
#
# Sourced library that probes for an existing Ollama instance and lets
# the operator point the installer at a remote one when nothing runs
# locally. Sets:
#   OLLAMA_URL            -- the URL the runtime should use (default
#                            http://localhost:11434)
#   INSTALLER_OLLAMA_INSTALL -- "1" if the installer should run the
#                              native install procedure now, "0"
#                              otherwise
#   INSTALLER_OLLAMA_SKIP -- "1" if the operator opted out of Ollama
#                            entirely (no semantic memory)
#
# Read from stdin so BATS can pipe scripted input. Mockable hooks:
#   _installer_curl()      -- default: curl -fsS --max-time 2 URL
#   _installer_log_info()  -- default: printf '%s\n' "$*"
#   _installer_log_warn()  -- default: printf '%s\n' "$*" >&2
#   _installer_install_ollama() -- REQUIRED: the installer MUST provide a
#                                  platform-specific install command.
#                                  The library never defaults this; the
#                                  previous code lives in install-linux.sh
#                                  (curl ... | sh) and install-macos.sh
#                                  (brew install || curl ... | sh).
#   _installer_start_ollama()  -- OPTIONAL: hook used by installer_ollama_wait_ready
#                                to start the local service before probing.

set -u

# --- Mockable hooks ---------------------------------------------------------

if ! declare -F _installer_curl >/dev/null; then
  _installer_curl() { curl -fsS --max-time 2 "$1" 2>/dev/null; }
fi
if ! declare -F _installer_log_info >/dev/null; then
  _installer_log_info() { printf '%s\n' "$*"; }
fi
if ! declare -F _installer_log_warn >/dev/null; then
  _installer_log_warn() { printf '%s\n' "$*" >&2; }
fi
if ! declare -F _installer_install_ollama >/dev/null; then
  _installer_install_ollama() {
    _installer_log_warn "  _installer_install_ollama hook is not defined; install aborted"
    return 1
  }
fi

# --- Public API -------------------------------------------------------------

installer_ollama_init() {
  OLLAMA_URL=""
  INSTALLER_OLLAMA_INSTALL=""
  INSTALLER_OLLAMA_SKIP=""
}

# Probes localhost (or the URL the operator already gave us) and walks the
# operator through the choices when nothing is running.
#
# Reads one numeric line from stdin (1, 2, 3, or 4) when nothing is
# reachable locally. With BATS tests we redirect stdin to a script.
installer_ollama_discover() {
  local probe_url="${OLLAMA_URL:-http://localhost:11434}"
  _installer_log_info ""
  _installer_log_info "  Ollama discovery:"
  _installer_log_info "    probing $probe_url ..."
  if _installer_curl "$probe_url/api/version" >/dev/null; then
    _installer_log_info "    OK -- using $probe_url"
    OLLAMA_URL="$probe_url"
    INSTALLER_OLLAMA_INSTALL="0"
    INSTALLER_OLLAMA_SKIP="0"
    return 0
  fi
  _installer_log_warn "    not reachable"

  # Nothing reachable at the URL the operator picked (or the default
  # localhost). Walk the four options.
  _installer_log_info ""
  _installer_log_info "  Nincs elerheto Ollama. Mit tegyunk?"
  _installer_log_info "    1. Mashol fut, ide megadom az URL-t (pl. http://192.168.0.10:11434)"
  _installer_log_info "    2. Telepitsd most helyben"
  _installer_log_info "    3. Ollama nelkul megyunk tovabb (szemantikus memoria kimarad)"
  _installer_log_info ""
  local choice=""
  read -r choice || choice=""
  choice="${choice:-1}"

  case "$choice" in
    1)
      _installer_log_info "    Add meg az Ollama URL-t:"
      read -r OLLAMA_URL
      OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"
      _installer_log_info "    probing $OLLAMA_URL ..."
      if _installer_curl "$OLLAMA_URL/api/version" >/dev/null; then
        _installer_log_info "    OK -- using $OLLAMA_URL"
        INSTALLER_OLLAMA_INSTALL="0"
        INSTALLER_OLLAMA_SKIP="0"
        return 0
      fi
      _installer_log_warn "    a megadott URL nem elerheto -- Ollama nelkul megyunk tovabb"
      INSTALLER_OLLAMA_INSTALL="0"
      INSTALLER_OLLAMA_SKIP="1"
      OLLAMA_URL=""
      return 0
      ;;
    2)
      _installer_log_info "  Ollama telepitese..."
      if _installer_install_ollama; then
        _installer_log_info "  ok: ollama telepitve"
        OLLAMA_URL="http://localhost:11434"
        INSTALLER_OLLAMA_INSTALL="0"
        INSTALLER_OLLAMA_SKIP="0"
        return 0
      fi
      _installer_log_warn "  ollama telepitese sikertelen -- a szemantikus memoria kimarad"
      OLLAMA_URL=""
      INSTALLER_OLLAMA_INSTALL="0"
      INSTALLER_OLLAMA_SKIP="1"
      return 0
      ;;
    3)
      _installer_log_info "  Ollama kihagyva (szemantikus memoria kimarad)."
      OLLAMA_URL=""
      INSTALLER_OLLAMA_INSTALL="0"
      INSTALLER_OLLAMA_SKIP="1"
      return 0
      ;;
    *)
      _installer_log_warn "  ismeretlen valasz: '$choice' -- Ollama kihagyva"
      INSTALLER_OLLAMA_INSTALL="0"
      INSTALLER_OLLAMA_SKIP="1"
      return 0
      ;;
  esac
}

# Probe-and-wait: starts the local ollama systemd/launchd service if it is
# installed but not running, then waits up to $1 seconds for the API to
# answer. The caller can override _installer_start_ollama to skip the start
# attempt (e.g. when the binary itself is missing). Returns 0 on success.
installer_ollama_wait_ready() {
  local timeout="${1:-15}"
  local url="${OLLAMA_URL:-http://localhost:11434}"
  if _installer_curl "$url/api/version" >/dev/null; then
    return 0
  fi
  if declare -F _installer_start_ollama >/dev/null; then
    _installer_start_ollama || true
  fi
  local i
  for i in $(seq 1 "$timeout"); do
    if _installer_curl "$url/api/version" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

export -f installer_ollama_init installer_ollama_discover installer_ollama_wait_ready
INSTALLER_OLLAMA_DISCOVERY_LOADED=1
export INSTALLER_OLLAMA_DISCOVERY_LOADED=1