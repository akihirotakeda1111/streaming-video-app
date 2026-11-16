#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

export AWS_REGION="${AWS_REGION:-us-east-1}"
export VIDEO_INPUT_BUCKET="${VIDEO_INPUT_BUCKET:-streaming-video-input-e2e}"
export VIDEO_OUTPUT_BUCKET="${VIDEO_OUTPUT_BUCKET:-streaming-video-output-e2e}"
export VIDEO_ENCODING_QUEUE_URL="${VIDEO_ENCODING_QUEUE_URL:-https://sqs.${AWS_REGION}.amazonaws.com/000000000000/streaming-video-encoding}"
export API_PORT="${API_PORT:-8000}"
export FRONTEND_PORT="${FRONTEND_PORT:-5173}"
export FRONTEND_ORIGIN="${FRONTEND_ORIGIN:-http://localhost:${FRONTEND_PORT}}"
export VITE_API_BASE_URL="${VITE_API_BASE_URL:-http://127.0.0.1:${API_PORT}/api/v1}"
export OUTPUT_S3_ENDPOINT="${OUTPUT_S3_ENDPOINT:-http://127.0.0.1:9298}"
export PLAYBACK_BASE_URL="${PLAYBACK_BASE_URL:-http://127.0.0.1:9298}"

compose=(docker compose -f app/compose.yaml -f app/compose.local-emulator.yaml)
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

wait_for_http s3-cors-proxy "http://127.0.0.1:9298/__proxy-health" 60
wait_for_http api "http://127.0.0.1:${API_PORT}/api/v1/health" 60
wait_for_http frontend "http://127.0.0.1:${FRONTEND_PORT}/" 60
wait_for_worker
