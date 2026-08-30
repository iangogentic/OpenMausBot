#!/usr/bin/env bash
set -euo pipefail

readonly container_name="qwen38-huihui-quality-canary"
readonly obsolete_unit="qwen38-huihui-abliterated-w8a16.service"

if ! docker inspect "$container_name" >/dev/null 2>&1; then
  echo "missing required container: $container_name" >&2
  exit 1
fi

docker update --restart unless-stopped "$container_name" >/dev/null
systemctl disable --now "$obsolete_unit"
docker start "$container_name" >/dev/null

test "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$container_name")" = "unless-stopped"
test "$(docker inspect -f '{{.State.Running}}' "$container_name")" = "true"
test "$(systemctl is-enabled "$obsolete_unit" 2>/dev/null || true)" = "disabled"

