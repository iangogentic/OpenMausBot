#!/usr/bin/env bash
set -euo pipefail

readonly container_name="qwen38-huihui-abliterated-w8a16"
readonly model_dir="/mnt/storage/int-tosh-1tb/qwen38-huihui-abliterated-w8a16-1bad8295/model"
readonly cache_root="/mnt/storage/int-tosh-1tb/qwen38-huihui-abliterated-w8a16-1bad8295"
readonly image="vllm/vllm-openai:qwen38-x86_64-cu129"

test -f "$model_dir/config.json"
mkdir -p "$cache_root/vllm" "$cache_root/triton"

if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker update --restart=no "$container_name" >/dev/null || true
  docker stop "$container_name" >/dev/null 2>&1 || true
  docker rm "$container_name" >/dev/null
fi

docker create \
  --name "$container_name" \
  --gpus all \
  --ipc host \
  --shm-size=16g \
  --network host \
  --restart no \
  -e NCCL_P2P_DISABLE=1 \
  -e VLLM_USE_STANDALONE_COMPILE=0 \
  -e VLLM_USE_MEGA_AOT_ARTIFACT=0 \
  -v "$model_dir:/model:ro" \
  -v "$cache_root/vllm:/root/.cache/vllm" \
  -v "$cache_root/triton:/root/.triton/cache" \
  "$image" \
  /model \
  --served-model-name qwen3.8-27b-abliterated qwen3.8-27b \
  --tensor-parallel-size 2 \
  --dtype bfloat16 \
  --max-model-len 262144 \
  --port 8011 \
  --gpu-memory-utilization 0.93 \
  --kv-cache-dtype fp8 \
  --mamba-ssm-cache-dtype float16 \
  --max-num-seqs 8 \
  --max-num-batched-tokens 8192 \
  --enable-prefix-caching \
  --enable-chunked-prefill \
  --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking":false}' \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --mm-processor-kwargs '{"max_pixels":4194304,"min_pixels":65536}' \
  --override-generation-config '{"temperature":0.7,"top_p":0.8,"top_k":20}' \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3,"draft_sample_method":"probabilistic"}'

echo "Created $container_name"
