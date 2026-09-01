# Razer OpenMaus to dual-Spark GLM

This deployment adds the live two-DGX-Spark GLM service as a named local model
provider for every OpenMaus harness. The Hermes bot selection is:

```text
spark_glm::glm-5.3-flash
```

The current Spark endpoint requires its API key. Store it outside the Git
checkout as a root-only environment file:

```text
OPENMAUSBOT_SPARK_GLM_API_KEY=replace-with-the-live-spark-key
```

Install that file at `/etc/openmausbot/spark-glm.env` with mode `0600`, then
install the included system-service drop-in. The service intentionally fails
closed when the key file is missing:

```bash
sudo install -Dm644 spark-glm.conf \
  /etc/systemd/system/openmausbot.service.d/spark-glm.conf
sudo systemctl daemon-reload
sudo systemctl restart openmausbot.service
```

The Spark endpoint is private to the Tailscale network. The existing Hermes
MCP configuration is shared by Hermes sessions, so a bot using this GLM model
also receives the `ian_brain` MCP server. Acceptance requires a direct Spark
generation, a real OpenMaus bot turn, and a successful Ian Brain tool activity
from that same bot.
