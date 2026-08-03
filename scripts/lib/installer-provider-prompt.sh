#!/bin/bash
# installer-provider-prompt.sh
#
# Sourced library that drives the install-time provider selection and
# per-provider credential capture. Both install-linux.sh and install-macos.sh
# source this file and call installer_prompt_provider at the auth step.
# Reads from stdin (so BATS can pipe scripted input) and sets the
# PROVIDER_MODE / PROVIDER_VAULT_* / PROVIDER_BASE_URL_* env vars in the
# caller's shell; the caller is responsible for the .env / RC writes on
# the Claude branch and for the post-service-start Vault push.
#
# All output is routed through mockable hooks so the BATS suite can run
# the library silently and assert on the resulting env vars.

set -u

# --- Mockable hooks ---------------------------------------------------------
#
# The default implementations print human-readable status lines. Override
# before calling installer_prompt_provider to capture output or run silently.
#
# Usage in tests:
#   _installer_log_info() { :; }            # silence
#   _installer_log_info() { printf '%s\n' "$*" >&2; }

if ! declare -F _installer_log_info >/dev/null; then
  _installer_log_info() { printf '%s\n' "$*"; }
fi
if ! declare -F _installer_log_warn >/dev/null; then
  _installer_log_warn() { printf '%s\n' "$*" >&2; }
fi
if ! declare -F _installer_log_ok >/dev/null; then
  _installer_log_ok() { printf '%s\n' "$*"; }
fi
if ! declare -F _installer_ensure_in_rc >/dev/null; then
  _installer_ensure_in_rc() { return 0; }
fi
if ! declare -F _installer_service_auth_present >/dev/null; then
  _installer_service_auth_present() { return 1; }
fi
if ! declare -F _installer_is_headless >/dev/null; then
  _installer_is_headless() {
    [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]
  }
fi

# --- Public API -------------------------------------------------------------

# Initialize the PROVIDER_* env vars to empty. Caller MUST invoke this once
# before installer_prompt_provider so the .env write block and the
# post-start Vault push see a stable contract.
installer_prompt_init() {
  PROVIDER_MODE=""
  PROVIDER_VAULT_ID=""
  PROVIDER_VAULT_LABEL=""
  PROVIDER_VAULT_VALUE=""
  PROVIDER_BASE_URL_KEY=""
  PROVIDER_BASE_URL_VALUE=""
}

# Reads the provider selection from stdin (one numeric choice + follow-up
# credential lines), captures the credential into PROVIDER_* vars, and
# leaves the post-start push hook ready. The caller MUST call
# installer_prompt_init first.
#
# Returns 0 always. On missing input it logs a warning and falls through
# to the empty-buffer state (the dashboard wizard can finish setup later).
installer_prompt_provider() {
  if _installer_service_auth_present; then
    _installer_log_ok "A telepites mar hordoz auth kulcsot"
    PROVIDER_MODE="1"
    PROVIDER_VAULT_ID="CLAUDE_CODE_OAUTH_TOKEN"
    PROVIDER_VAULT_LABEL="Anthropic Claude setup-token (existing)"
    local existing_token=""
    if [ -f "${INSTALL_DIR:-}/store/.claude-oauth-token" ]; then
      existing_token=$(cat "${INSTALL_DIR}/store/.claude-oauth-token" 2>/dev/null || true)
    fi
    PROVIDER_VAULT_VALUE="$existing_token"
    return 0
  fi

  if _installer_is_headless; then
    _installer_log_info ""
    _installer_log_info "  Headless szerver detektalva (nincs DISPLAY)."
    _installer_log_info "  Ajanlott: Anthropic OAuth token (1.2) vagy barmely API key."
    _installer_log_info ""
  fi

  _installer_log_info ""
  _installer_log_info "  Valassz modell-szolgaltatot:"
  _installer_log_info "  1. Anthropic Claude"
  _installer_log_info "  2. MiniMax"
  _installer_log_info "  3. DeepSeek"
  _installer_log_info "  4. OpenRouter"
  _installer_log_info "  5. Ollama"
  _installer_log_info "  6. Kihagyas"
  _installer_log_info ""

  local choice=""
  if [ -t 0 ]; then
    read -r choice
  else
    read -r choice || choice=""
  fi
  choice="${choice:-6}"
  PROVIDER_MODE="$choice"

  case "$PROVIDER_MODE" in
    1) _installer_prompt_anthropic ;;
    2) _installer_prompt_minimax ;;
    3) _installer_prompt_deepseek ;;
    4) _installer_prompt_openrouter ;;
    5) _installer_prompt_ollama ;;
    *) _installer_log_info "  Kihagyva." ;;
  esac
}

# --- Per-provider branches --------------------------------------------------

_installer_prompt_anthropic() {
  _installer_log_info ""
  _installer_log_info "  Anthropic Claude -- valassz hitelesitesi modot:"
  _installer_log_info "  1. API key"
  _installer_log_info "  2. OAuth token"
  _installer_log_info "  3. Kihagyas"

  local mode=""
  if _installer_is_headless; then
    read -r mode
    mode="${mode:-2}"
  else
    read -r mode
    mode="${mode:-3}"
  fi

  case "$mode" in
    1) _installer_prompt_anthropic_apikey ;;
    2) _installer_prompt_anthropic_oauth ;;
    *) _installer_log_info "  Kihagyva (kesobb allitod be)." ;;
  esac
}

_installer_prompt_anthropic_apikey() {
  _installer_log_info ""
  _installer_log_info "  ANTHROPIC_API_KEY (sk-ant-...):"
  local key=""
  read -r key
  if [ -z "$key" ]; then
    _installer_log_warn "  API key nem lett megadva, kihagyas."
    return 0
  fi
  _installer_ensure_in_rc 'ANTHROPIC_API_KEY' "export ANTHROPIC_API_KEY=\"$key\""
  PROVIDER_VAULT_ID="ANTHROPIC_API_KEY"
  PROVIDER_VAULT_LABEL="Anthropic API key"
  PROVIDER_VAULT_VALUE="$key"
  _installer_log_ok "  ANTHROPIC_API_KEY beallitva"
}

_installer_prompt_anthropic_oauth() {
  _installer_log_info ""
  _installer_log_info "  OAuth token (sk-ant-oat01-...):"
  local token=""
  read -r token
  if [ -z "$token" ]; then
    _installer_log_warn "  Token nem lett megadva, kihagyas."
    return 0
  fi
  _installer_ensure_in_rc 'CLAUDE_CODE_OAUTH_TOKEN' "export CLAUDE_CODE_OAUTH_TOKEN=\"$token\""
  PROVIDER_VAULT_ID="CLAUDE_CODE_OAUTH_TOKEN"
  PROVIDER_VAULT_LABEL="Anthropic Claude setup-token"
  PROVIDER_VAULT_VALUE="$token"
  _installer_log_ok "  Anthropic OAuth token elfogadva"
}

_installer_prompt_minimax() {
  _installer_log_info ""
  _installer_log_info "  MiniMax -- valassz endpointot:"
  _installer_log_info "  1. Globalis (https://api.minimax.io/anthropic)"
  _installer_log_info "  2. Kinai regio (https://api.minimaxi.com/anthropic)"

  local region=""
  read -r region
  region="${region:-1}"

  if [ "$region" = "2" ]; then
    PROVIDER_BASE_URL_VALUE="https://api.minimaxi.com/anthropic"
  else
    PROVIDER_BASE_URL_VALUE="https://api.minimax.io/anthropic"
  fi
  PROVIDER_BASE_URL_KEY="MINIMAX_BASE_URL"

  _installer_log_info ""
  _installer_log_info "  MINIMAX_API_KEY:"
  local key=""
  read -r key
  if [ -z "$key" ]; then
    _installer_log_warn "  MiniMax API key nem lett megadva."
    return 0
  fi
  PROVIDER_VAULT_ID="MINIMAX_API_KEY"
  PROVIDER_VAULT_LABEL="MiniMax API key"
  PROVIDER_VAULT_VALUE="$key"
  _installer_log_ok "  MiniMax konfiguracio elokeszitve"
}

_installer_prompt_deepseek() {
  _installer_log_info ""
  _installer_log_info "  DEEPSEEK_API_KEY:"
  local key=""
  read -r key
  if [ -z "$key" ]; then
    _installer_log_warn "  DeepSeek API key nem lett megadva."
    return 0
  fi
  PROVIDER_VAULT_ID="DEEPSEEK_API_KEY"
  PROVIDER_VAULT_LABEL="DeepSeek API key"
  PROVIDER_VAULT_VALUE="$key"
  _installer_log_ok "  DeepSeek konfiguracio elokeszitve"
}

_installer_prompt_openrouter() {
  _installer_log_info ""
  _installer_log_info "  openrouter-fleet-key:"
  local key=""
  read -r key
  if [ -z "$key" ]; then
    _installer_log_warn "  OpenRouter API key nem lett megadva."
    return 0
  fi
  PROVIDER_VAULT_ID="openrouter-fleet-key"
  PROVIDER_VAULT_LABEL="OpenRouter API key"
  PROVIDER_VAULT_VALUE="$key"
  _installer_log_ok "  OpenRouter konfiguracio elokeszitve"
}

_installer_prompt_ollama() {
  _installer_log_info ""
  _installer_log_info "  OLLAMA_URL [default: http://localhost:11434]:"
  local url=""
  read -r url
  url="${url:-http://localhost:11434}"
  PROVIDER_BASE_URL_KEY="OLLAMA_URL"
  PROVIDER_BASE_URL_VALUE="$url"
  _installer_log_ok "  Ollama konfiguracio elokeszitve (URL: $PROVIDER_BASE_URL_VALUE)"
}

# Export the public API and a marker so tests / installers can detect that
# the library has been sourced.
export -f installer_prompt_init installer_prompt_provider
INSTALLER_PROVIDER_PROMPT_LOADED=1
export INSTALLER_PROVIDER_PROMPT_LOADED=1