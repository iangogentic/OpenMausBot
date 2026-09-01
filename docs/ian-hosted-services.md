# Ian hosted services

OpenMaus uses Ian's two stable hosted interfaces. Client configuration must
not name Desktop2, either DGX Spark, a Tailscale address, or a temporary SSH
port forward.

## Model API

- Base URL: `https://models.zai-brain.com/v1`
- Canonical OpenMaus provider: `ian_models`
- Stable models: `qwen-3.8-27b` and `glm-5.3-flash`
- Secret environment variable: `OPENMAUSBOT_IAN_MODELS_API_KEY`
- Non-secret URL override: `OPENMAUSBOT_IAN_MODELS_URL`

The trusted OpenMaus server holds the upstream key. Each isolated provider
turn receives only an exact-model, exact-turn relay capability and never sees
the hosted URL or key. Both stable models are approved for screenshot/image
input, so a visual child uses the selected parent model rather than a separate
Qwen-only operator route.

`desktop2_qwen` and `spark_glm` remain decodable only for rollback of existing
state. New and migrated bots use `ian_models::<stable-model-id>`.

## Ian Brain MCP

- MCP URL: `https://mcp.iansalways.com/mcp`
- OpenMaus broker: `server/ian-brain-broker.ts`
- Hermes policy: `server/drivers/acp/hermes-policy.ts`

Every turn receives a short-lived signed OMB1 bearer. The OpenMaus capability
exposes the reviewed 27-tool Ian Brain subset; credentials, arbitrary shell,
and owner-admin tools are not registered in the model-facing MCP connection.

## Deployed request paths

```text
OpenMaus / Hermes
  |-- model relay --> https://models.zai-brain.com/v1
  |                    |-- qwen-3.8-27b
  |                    `-- glm-5.3-flash
  `-- Ian Brain ----> https://mcp.iansalways.com/mcp
```

The model platform may move work between Desktop2 and the Sparks behind the
stable API. That backend topology is not OpenMaus configuration.

## Razer deployment

Install `deploy/razer-remote/ian-models.conf` as the OpenMaus systemd drop-in
and store the scoped API key in `/etc/openmausbot/ian-models.env` with mode
`0600`. Once both bots have been migrated and proved, disable the obsolete
`openmaus-qwen-cloud-proxy.service` and remove the legacy model-route drop-ins.
Keep their environment files and the prior immutable release until restart
and fresh-turn acceptance passes.

Acceptance requires all of the following after a restart:

1. The picker advertises both stable IDs under `ian_models`.
2. GLM and Qwen each complete a fresh text turn through the public endpoint.
3. Each model reads a unique marker from actual screenshot pixels.
4. Each model calls the real hosted Ian Brain `wiki_index` tool.
5. The returned model identity and visual-child model match the selected
   parent; health labels alone are insufficient.
