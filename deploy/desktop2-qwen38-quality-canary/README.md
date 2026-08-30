# desktop2 Qwen quality-canary restart policy

The active OpenMaus computer-operator model is the existing Docker container
`qwen38-huihui-quality-canary`, serving
`qwen38-huihui-w8-quality-canary` on desktop2 loopback port 8012. Bifrost and
llama-swap expose the stable authenticated alias `qwen-quality-canary`; Razer
reaches Bifrost only through its persistent loopback SSH tunnel.

Docker owns boot recovery for the exact active container. Install or repair
that policy on desktop2 with:

```sh
sudo ./ensure-restart-policy.sh
```

The script also disables the obsolete
`qwen38-huihui-abliterated-w8a16.service`, which points at a different stopped
container and must not compete for the same GPUs after reboot. It deliberately
fails if the exact active container is missing instead of silently launching a
different model.

Verify the served artifact after a restart:

```sh
curl -fsS http://127.0.0.1:8012/v1/models
docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Running}}' \
  qwen38-huihui-quality-canary
```
