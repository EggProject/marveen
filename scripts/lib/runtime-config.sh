#!/bin/sh

runtime_config_init() {
  RUNTIME_CONFIG_ROOT="$1"
  RUNTIME_CONFIG_NODE="${NODE_BIN:-$(command -v node || true)}"
  RUNTIME_CONFIG_BRIDGE="${RUNTIME_CONFIG_BRIDGE:-$RUNTIME_CONFIG_ROOT/scripts/runtime-config.mjs}"
  if [ -z "$RUNTIME_CONFIG_NODE" ] || [ ! -f "$RUNTIME_CONFIG_BRIDGE" ]; then
    printf '%s\n' 'runtime config bridge unavailable' >&2
    return 1
  fi
}

runtime_config_get() {
  "$RUNTIME_CONFIG_NODE" "$RUNTIME_CONFIG_BRIDGE" --root "$RUNTIME_CONFIG_ROOT" get "$1"
}

runtime_config_get_many() {
  "$RUNTIME_CONFIG_NODE" "$RUNTIME_CONFIG_BRIDGE" --root "$RUNTIME_CONFIG_ROOT" get-many "$@"
}

runtime_config_has_secret() {
  "$RUNTIME_CONFIG_NODE" "$RUNTIME_CONFIG_BRIDGE" --root "$RUNTIME_CONFIG_ROOT" has-secret "$1"
}
