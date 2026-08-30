export function shouldMountLocalComputer({
  requested,
  hostPlatform = process.platform,
  providerSupportsLocal,
}: {
  requested: "cloud" | "local" | "off" | undefined;
  hostPlatform?: NodeJS.Platform;
  providerSupportsLocal: boolean;
}): boolean {
  if (!providerSupportsLocal) return false;
  if (requested === "local") {
    return hostPlatform === "darwin" || hostPlatform === "linux" || hostPlatform === "win32";
  }
  // Attended Mac and Windows bridges may be published by a remote Linux
  // harness. Route from the actual connection descriptor's platform, not the
  // harness process platform. Native Linux local control remains explicit-only.
  return requested === undefined && (hostPlatform === "darwin" || hostPlatform === "win32");
}
