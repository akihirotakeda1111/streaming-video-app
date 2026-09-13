#!/usr/bin/env bash
# Offline Bash integration checks. Node orchestration has separate unit tests.
set -euo pipefail
setup=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../scripts" && pwd)/setup_reliability_env.sh

(
  node() { printf '%s\n' 'E2E_VALID_FIXTURE=/tmp/normal 動画 with spaces.mp4' 'E2E_INVALID_FIXTURE=/tmp/$(touch should-not-exist);`false`.mp4'; }
  source "$setup"
  [[ $E2E_VALID_FIXTURE == '/tmp/normal 動画 with spaces.mp4' ]]
  [[ $E2E_INVALID_FIXTURE == '/tmp/$(touch should-not-exist);`false`.mp4' ]]
  bash -c '[[ $E2E_VALID_FIXTURE == "/tmp/normal 動画 with spaces.mp4" ]]'
  ! declare -F _setup_reliability_env
)
(
  node() { printf '%s\n' 'E2E_VALID_FIXTURE=partial'; return 2; }
  export E2E_VALID_FIXTURE=previous
  if source "$setup"; then exit 1; fi
  [[ $E2E_VALID_FIXTURE == previous ]]
)
(
  node() { printf '%s\n' 'E2E_VALID_FIXTURE=new' 'E2E_INVALID_FIXTURE=invalid'; }
  export E2E_VALID_FIXTURE=previous
  readonly E2E_INVALID_FIXTURE=old
  if source "$setup"; then exit 1; fi
  [[ $E2E_VALID_FIXTURE == previous ]]
)
(
  node() { printf '%s\n' 'E2E_VALID_FIXTURE=new' 'bad setting'; }
  export E2E_VALID_FIXTURE=previous
  if source "$setup"; then exit 1; fi
  [[ $E2E_VALID_FIXTURE == previous ]]
)
(
  node() { return 0; }
  source "$setup" --help
  [[ ! -v E2E_VALID_FIXTURE ]]
)
if bash "$setup"; then exit 1; fi
printf '%s\n' '6 offline Bash setup checks passed.'
