#!/usr/bin/env bash
set -euo pipefail

required=(
  AWS_REGION
  VIDEO_ENCODING_QUEUE_URL
  VIDEO_INPUT_BUCKET
  VIDEO_OUTPUT_BUCKET
  API_AWS_ACCESS_KEY_ID
  API_AWS_SECRET_ACCESS_KEY
  WORKER_AWS_ACCESS_KEY_ID
  WORKER_AWS_SECRET_ACCESS_KEY
)

for name in "${required[@]}"; do
  if [ -z "${!name:-}" ]; then
    echo "$name is required" >&2
    exit 1
  fi
done

export API_PORT="${API_PORT:-8000}"
export FRONTEND_PORT="${FRONTEND_PORT:-5173}"
export FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:${FRONTEND_PORT}}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://127.0.0.1:${API_PORT}/api/v1}"
export OUTPUT_S3_ENDPOINT="${OUTPUT_S3_ENDPOINT:-https://${VIDEO_OUTPUT_BUCKET}.s3.${AWS_REGION}.amazonaws.com}"

compose=(docker compose -f app/compose.yaml)
cleanup_on_failure() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" down --remove-orphans || true
  fi
}
trap cleanup_on_failure EXIT

"${compose[@]}" up --build -d

wait_for_http() {
  local service="$1"
  local url="$2"
  local attempts="$3"

  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if curl --fail --silent "$url" >/dev/null; then
      return 0
    fi
    sleep 2
  done

  echo "$service did not become ready" >&2
  "${compose[@]}" logs --no-color --tail 100 "$service" >&2
  return 1
}

wait_for_worker() {
  for ((attempt = 1; attempt <= 120; attempt++)); do
    if "${compose[@]}" logs --no-color worker 2>&1 | grep -q '"message":"worker started"'; then
      return 0
    fi
    if ! "${compose[@]}" ps --status running --services | grep -Fxq worker; then
      echo "worker stopped before becoming ready" >&2
      "${compose[@]}" logs --no-color --tail 100 worker >&2
      return 1
    fi
    sleep 2
  done

  echo "worker did not become ready" >&2
  "${compose[@]}" logs --no-color --tail 100 worker >&2
  return 1
}

wait_for_http api "http://127.0.0.1:${API_PORT}/api/v1/health" 60
wait_for_http frontend "http://127.0.0.1:${FRONTEND_PORT}/" 60
wait_for_worker
