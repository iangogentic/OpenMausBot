# Razer OpenMaus to dual-Spark GLM

This deployment adds the live two-DGX-Spark GLM service as a named local model
provider for every OpenMaus harness. The Hermes bot selection is:

```text
spark_glm::glm53-ablit-dflash2-k7-b4096-ms1-1m
```

On Razer, install the included systemd drop-in:

```bash
install -Dm644 spark-glm.conf \
  /home/ian/.config/systemd/user/openmausbot.service.d/spark-glm.conf
systemctl --user daemon-reload
systemctl --user restart openmausbot.service
```

The Spark endpoint is private to the Tailscale network. The existing Hermes
MCP configuration is shared by Hermes sessions, so a bot using this GLM model
also receives the `ian_brain` MCP server. Acceptance requires a direct Spark
generation, a real OpenMaus bot turn, and a successful Ian Brain tool activity
from that same bot.
