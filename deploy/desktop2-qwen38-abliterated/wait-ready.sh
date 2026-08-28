#!/usr/bin/env bash
set -euo pipefail

readonly endpoint="http://127.0.0.1:8011/v1/models"
readonly deadline=$((SECONDS + 900))

until curl --fail --silent --max-time 5 "$endpoint" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "Timed out waiting for $endpoint" >&2
    docker logs --tail 200 qwen38-huihui-abliterated-w8a16 >&2 || true
    exit 1
  fi
  if ! docker inspect -f '{{.State.Running}}' qwen38-huihui-abliterated-w8a16 2>/dev/null | grep -qx true; then
    echo "Model container stopped before becoming ready" >&2
    docker logs --tail 200 qwen38-huihui-abliterated-w8a16 >&2 || true
    exit 1
  fi
  sleep 5
done

echo "Qwen 3.8 27B Abliterated is ready on port 8011"
