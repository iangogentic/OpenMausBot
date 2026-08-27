import fs from "node:fs";
import path from "node:path";

export const REMOTE_CLIENT_CONFIG_FILE = "remote-client.json";

function loopbackHostname(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(value)
  );
}

/**
 * A remote desktop client receives every renderer request, cookie and
 * credential entered in the UI. Require HTTPS unless the origin is loopback,
 * where an SSH/Tailscale tunnel can provide the encrypted transport.
 */
export function normalizeRemoteServerURL(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let parsed;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error("The remote OpenMausBot server address is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The remote OpenMausBot server must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("The remote OpenMausBot server address cannot contain credentials");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("The remote OpenMausBot server address must be an origin without a path");
  }
  if (parsed.protocol === "http:" && !loopbackHostname(parsed.hostname)) {
    throw new Error("A non-loopback remote OpenMausBot server must use HTTPS");
  }
  return parsed.origin;
}

export function remoteClientConfigPath(userDataDir) {
  return path.join(userDataDir, REMOTE_CLIENT_CONFIG_FILE);
}

function commandLineRemoteURL(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--remote-server=")) return value.slice("--remote-server=".length);
    if (value === "--remote-server") return argv[index + 1] ?? "";
  }
  return null;
}

export function readRemoteClientConfig(userDataDir, readFile = fs.readFileSync) {
  try {
    const parsed = JSON.parse(readFile(remoteClientConfigPath(userDataDir), "utf8"));
    if (parsed?.mode !== "remote") return null;
    return normalizeRemoteServerURL(parsed.serverUrl);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** CLI wins for one-off diagnostics, then the environment, then durable setup. */
export function resolveRemoteClientURL({ argv, env, userDataDir, readFile } = {}) {
  const commandLine = commandLineRemoteURL(argv ?? []);
  if (commandLine !== null) return normalizeRemoteServerURL(commandLine);
  if (env?.OMB_REMOTE_URL?.trim()) return normalizeRemoteServerURL(env.OMB_REMOTE_URL);
  return readRemoteClientConfig(userDataDir, readFile);
}
