export interface ComputerLocationCopy {
  remote: boolean;
  serverName: string;
  vmLabel: string;
  localLabel: string;
  localDestination: string;
  vmDestination: string;
}

export type ComputerDestinationMode = "auto" | "cloud" | "vm" | "local" | "off";
export type HostedComputerBackend = "box" | "vps";

export interface ComputerDestinationContext {
  platform: DesktopCapabilities["host"]["platform"];
  autoPhysicalFallbackAvailable: boolean;
  autoStartVps: boolean;
  computerEngine: boolean;
  localVmMode: "shared" | "per-bot";
}

/**
 * The bot process and the computer it controls are separate. A remote Mac
 * client makes that especially easy to miss: the agent and shell stay on the
 * server while "This Mac" deliberately routes only computer-control tools
 * back through the attended bridge.
 */
export function computerLocationCopy(capabilities: DesktopCapabilities): ComputerLocationCopy {
  const remote = capabilities.connection?.mode === "remote";
  const serverName = capabilities.connection?.serverName?.trim() || "Remote server";
  const localLabel =
    capabilities.host.platform === "darwin"
      ? "This Mac"
      : capabilities.host.platform === "win32"
        ? "This Windows PC"
        : "This computer";
  return {
    remote,
    serverName,
    vmLabel: remote ? `${serverName} desktop` : "Private desktop",
    localLabel,
    localDestination:
      capabilities.host.platform === "darwin"
        ? "this Mac"
        : capabilities.host.platform === "win32"
          ? "this Windows PC"
          : "this computer",
    vmDestination: remote ? `the private desktop on ${serverName}` : "the private desktop",
  };
}

/** User-facing destination names. "Cloud" is deliberately never used as a
 * location: on a remote client it is too easy to mistake the remote server
 * itself for the separate hosted Box/VPS product. */
export function computerDestinationLabel(
  mode: ComputerDestinationMode,
  copy: ComputerLocationCopy,
  cloudBackend: HostedComputerBackend,
): string {
  if (mode === "auto") return "Automatic";
  if (mode === "cloud") return cloudBackend === "vps" ? "Remote VPS" : "Hosted Box";
  if (mode === "vm") return copy.vmLabel;
  if (mode === "local") return copy.localLabel;
  return "Off";
}

export function unsupportedHostedDestinationMessage(
  cloudBackend: HostedComputerBackend,
): string {
  return cloudBackend === "vps"
    ? "This model engine cannot use Remote VPS. Choose Claude or an ACP engine, or select Hosted Box in Agent profile → Controlled desktop."
    : "This model engine cannot use Hosted Box. Choose Claude, an ACP engine, or the Computer engine.";
}

export function computerDestinationDescription(
  mode: ComputerDestinationMode,
  copy: ComputerLocationCopy,
  cloudBackend: HostedComputerBackend,
  context: ComputerDestinationContext,
): string {
  const hosted = cloudBackend === "vps" ? "Remote VPS" : "Hosted Box";
  const physicalFallback =
    context.platform !== "linux" && context.autoPhysicalFallbackAvailable
      ? ` Otherwise it uses ${copy.localDestination}.`
      : " Otherwise desktop-control tools stay off.";
  if (mode === "auto") {
    if (context.computerEngine) {
      return cloudBackend === "box"
        ? "Runs the Computer engine inside Hosted Box, creating or waking it when needed."
        : "The Computer engine cannot use Remote VPS. Select Hosted Box below.";
    }
    if (context.localVmMode === "per-bot") {
      const runtime = copy.remote ? ` The main AI session and workspace stay on ${copy.serverName}.` : "";
      return `Uses this bot's isolated Linux desktop${copy.remote ? ` on ${copy.serverName}` : ""}. It cannot see or click your physical computer.${runtime}`;
    }
    const hostedAction = cloudBackend === "vps" && context.autoStartVps
      ? "Uses Remote VPS and may create or wake its managed desktop."
      : cloudBackend === "box"
        ? "Reuses an existing Hosted Box desktop and wakes it when needed; it does not create one."
        : "Reuses an existing Remote VPS desktop when one is ready.";
    const runtime = copy.remote ? ` The main AI session and workspace stay on ${copy.serverName}.` : "";
    return `${hostedAction}${physicalFallback}${runtime}`;
  }
  if (mode === "cloud") {
    if (context.computerEngine) {
      return cloudBackend === "box"
        ? "Runs the Computer engine, desktop, shell, and disk together inside Hosted Box."
        : "The Computer engine cannot use Remote VPS. Select Hosted Box below.";
    }
    return copy.remote
      ? `Desktop-control tools act inside ${hosted}. This is separate from ${copy.serverName}; the main AI session and workspace stay on ${copy.serverName}.`
      : `Desktop-control tools act inside ${hosted}.`;
  }
  if (mode === "vm") {
    const owner = context.localVmMode === "per-bot" ? "this bot's isolated Linux desktop" : "the shared isolated Linux desktop";
    return copy.remote
      ? `Controls ${owner} on ${copy.serverName}. It cannot see or click your physical computer.`
      : `Controls ${owner}. It cannot see or click your physical computer.`;
  }
  if (mode === "local") {
    return copy.remote
      ? `Desktop-control tools act on your physical ${copy.localDestination.replace(/^this /, "")} through the attended bridge. The main AI session and workspace stay on ${copy.serverName}.`
      : `Controls ${copy.localDestination} through the attended bridge.`;
  }
  return context.computerEngine
    ? "The Computer engine cannot run while desktop access is Off. Choose Hosted Box or switch this bot to another engine."
    : "No desktop-control tools are connected to this bot.";
}
