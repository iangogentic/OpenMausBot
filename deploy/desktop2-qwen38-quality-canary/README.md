# desktop2 stable Qwen backend restart policy

The active OpenMaus computer-operator model is the existing Docker container
`qwen38-huihui-quality-canary`, serving on desktop2 loopback port 8012. Bifrost
and llama-swap expose the stable authenticated alias `qwen-3.8-27b`; Razer
reaches Bifrost only through its persistent loopback SSH tunnel.

The user service `qwen38-huihui-quality-canary.service` owns boot recovery for
the exact active container; Docker's own restart policy remains `no`. The
legacy helper below is retained only for older deployments and must not replace
the current systemd ownership contract without a reviewed migration:

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
systemctl --user is-active qwen38-huihui-quality-canary.service
docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Running}}' \
  qwen38-huihui-quality-canary
```
