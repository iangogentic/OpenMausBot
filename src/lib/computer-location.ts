export interface ComputerLocationCopy {
  remote: boolean;
  serverName: string;
  vmLabel: string;
  localLabel: string;
  localDestination: string;
  vmDestination: string;
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
  const localLabel = capabilities.host.platform === "darwin" ? "This Mac" : "This computer";
  return {
    remote,
    serverName,
    vmLabel: remote ? `${serverName} VM` : "Local VM",
    localLabel,
    localDestination: capabilities.host.platform === "darwin" ? "this Mac" : "this computer",
    vmDestination: remote ? `the ${serverName} VM` : "the Local VM",
  };
}
