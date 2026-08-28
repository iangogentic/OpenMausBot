# desktop2 Qwen 3.8 27B Abliterated

This deployment serves the pinned checkpoint
`lued/Qwen3.8-27B-huihui-abliterated-INT8-W8A16-MTP` revision
`1bad8295d9c0e18fe88c74b4b4e291da0d61b07c` from desktop2's two RTX 3090 GPUs.

The OpenAI-compatible endpoint remains `http://desktop2:8011/v1`. It exposes
both `qwen3.8-27b-abliterated` and the compatibility alias `qwen3.8-27b`.

The deployment uses compressed-tensors W8A16 weights and preserves the vision
tower, output head, recurrent gates, and MTP in BF16. The model card measured
0.000705 mean KLD and 98.72% top-1 agreement against its own BF16 source. The
runtime uses FP8 KV cache and MTP speculative decoding with three draft tokens.
The physical source and previous normal-model deployment are retained for
rollback.

Install on desktop2:

```bash
sudo install -d /opt/qwen38-huihui-abliterated-w8a16/scripts
sudo install -m 755 run.sh wait-ready.sh /opt/qwen38-huihui-abliterated-w8a16/scripts/
sudo install -m 644 qwen38-huihui-abliterated-w8a16.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo /opt/qwen38-huihui-abliterated-w8a16/scripts/run.sh
sudo systemctl enable --now qwen38-huihui-abliterated-w8a16.service
```

Rollback without deleting either checkpoint:

```bash
sudo systemctl disable --now qwen38-huihui-abliterated-w8a16.service
sudo systemctl enable --now qwen38-autoround-int4.service
```
