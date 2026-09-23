#!/usr/bin/env bash
# Source this file in the Bash session used to run E2E. No eval or shell options changed.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  printf '%s\n' 'Use: source app/scripts/setup_scalability_env.sh [options]' >&2
  exit 2
fi

_setup_scalability_env() {
  local _scale_dir _scale_settings _scale_record _scale_name _scale_declaration
  local -a _scale_records=()
  _scale_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || return 1
  _scale_settings=$(node "$_scale_dir/setup_scalability_env.mjs" "$@") || return 1
  [[ -n $_scale_settings ]] || return 0
  while IFS= read -r _scale_record; do
    _scale_name=${_scale_record%%=*}
    if [[ ! $_scale_record == *=* || ! $_scale_name =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      printf '%s\n' 'Invalid generated setting; shell settings were not changed.' >&2
      return 1
    fi
    # Check every destination before exporting anything. Reject attributes that
    # could transform values, redirect assignment or prevent an atomic update.
    _scale_declaration=$(declare -p "$_scale_name" 2>/dev/null) || _scale_declaration=''
    if [[ $_scale_declaration =~ ^declare\ -[^[:space:]]*[aAirnlu] ]]; then
      printf 'Cannot set %s: unsupported shell variable attributes.\n' "$_scale_name" >&2
      return 1
    fi
    _scale_records+=("$_scale_record")
  done <<< "$_scale_settings"
  export "${_scale_records[@]}" || return 1
  printf '%s\n' 'Validated scalability E2E settings loaded into this Bash session.' >&2
}

if _setup_scalability_env "$@"; then
  unset -f _setup_scalability_env
  return 0
else
  unset -f _setup_scalability_env
  return 1
fi
