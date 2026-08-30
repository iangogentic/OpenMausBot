// Fail-closed stdio wrapper for an attended physical computer's arbitrary MCP
// command (local Mac/Linux Cua Driver or the remote Mac/Windows bridge).
// Local VM and VPS have specialized wrappers; this gives the exact same
// action-ticket drain, human lease, and computer_request_help behavior to the
// physical-host path without teaching the provider about its transport.

import { runMcpBridge } from "./mcp-bridge.ts";
import {
  PROVIDER_CREDENTIAL_ENV,
  stripWorkspaceCredentialEnv,
} from "./config.ts";

const command = process.env.OMB_GATED_MCP_COMMAND ?? "";
const rawArgs = process.env.OMB_GATED_MCP_ARGS ?? "";
const controlUrl = process.env.OMB_CONTROL_URL ?? "";
const controlToken = process.env.OMB_CONTROL_TOKEN ?? "";

/** This URL is an authority boundary, not merely a fetch destination. A
 * prefix check accepts userinfo such as `127.0.0.1:123@evil.example`; parse
 * it and pin every component the harness constructs instead. */
function validLoopbackControlUrl(value: string): boolean {
  if (!value || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    const port = Number(parsed.port);
    const params = [...parsed.searchParams.entries()];
    const botIds = parsed.searchParams.getAll("botId");
    const bridgeIds = parsed.searchParams.getAll("bridgeId");
    return (
      parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.username === "" &&
      parsed.password === "" &&
      /^\d{1,5}$/.test(parsed.port) &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535 &&
      parsed.pathname === "/api/internal/computer-control" &&
      parsed.hash === "" &&
      params.length === 2 &&
      botIds.length === 1 &&
      /^[\w-]{1,200}$/.test(botIds[0] ?? "") &&
      bridgeIds.length === 1 &&
      /^[\w-]{8,200}$/.test(bridgeIds[0] ?? "")
    );
  } catch {
    return false;
  }
}

let args: string[] | null = null;
try {
  const parsed: unknown = JSON.parse(rawArgs);
  if (
    Array.isArray(parsed) &&
    parsed.length <= 64 &&
    parsed.every((arg) => typeof arg === "string" && arg.length <= 8_192 && !arg.includes("\0"))
  ) {
    args = parsed;
  }
} catch {}

if (
  !command ||
  command.length > 8_192 ||
  /[\0\r\n]/.test(command) ||
  !args ||
  !validLoopbackControlUrl(controlUrl) ||
  !controlToken
) {
  process.stderr.write("invalid or unscoped physical-computer MCP connection\n");
  process.exit(2);
}

// The far-end driver needs its original MCP environment, not the wrapper's
// lease proof or launch description. Remove those before spawning it.
const driverEnv = { ...process.env };
stripWorkspaceCredentialEnv(driverEnv);
for (const key of PROVIDER_CREDENTIAL_ENV) delete driverEnv[key];
for (const key of [
  "OMB_GATED_MCP_COMMAND",
  "OMB_GATED_MCP_ARGS",
  "OMB_CONTROL_URL",
  "OMB_CONTROL_TOKEN",
]) {
  delete driverEnv[key];
}

runMcpBridge({
  command,
  args,
  env: driverEnv,
  label: "physical computer Cua Driver",
  gate: { url: controlUrl, token: controlToken },
});
