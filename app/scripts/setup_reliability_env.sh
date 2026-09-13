#!/usr/bin/env bash
# Source this file in the Bash session used to run E2E. No eval or shell options changed.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  printf '%s\n' 'Use: source app/scripts/setup_reliability_env.sh [options]' >&2
  exit 2
fi

_setup_reliability_env() {
  local _rel_dir _rel_settings _rel_record _rel_name _rel_declaration
  local -a _rel_records=()
  _rel_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || return 1
  _rel_settings=$(node "$_rel_dir/setup_reliability_env.mjs" "$@") || return 1
  [[ -n $_rel_settings ]] || return 0
  while IFS= read -r _rel_record; do
    _rel_name=${_rel_record%%=*}
    if [[ ! $_rel_record == *=* || ! $_rel_name =~ ^[A-Z][A-Z0-9_]*$ ]]; then
      printf '%s\n' 'Invalid generated setting; shell settings were not changed.' >&2
      return 1
    fi
    # Check every destination before exporting anything. Reject attributes that
    # could transform values, redirect assignment or prevent an atomic update.
    _rel_declaration=$(declare -p "$_rel_name" 2>/dev/null) || _rel_declaration=''
    if [[ $_rel_declaration =~ ^declare\ -[^[:space:]]*[aAirnlu] ]]; then
      printf 'Cannot set %s: unsupported shell variable attributes.\n' "$_rel_name" >&2
      return 1
    fi
    _rel_records+=("$_rel_record")
  done <<< "$_rel_settings"
  export "${_rel_records[@]}" || return 1
  printf '%s\n' 'Terraform and reliability E2E settings loaded into this Bash session.' >&2
}

if _setup_reliability_env "$@"; then
  unset -f _setup_reliability_env
  return 0
else
  unset -f _setup_reliability_env
  return 1
fi
