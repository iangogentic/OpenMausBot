import { describe, expect, it } from "vitest";
import { browserDesktopCapabilities } from "./desktop";
import {
  computerDestinationDescription,
  computerDestinationLabel,
  computerLocationCopy,
  unsupportedHostedDestinationMessage,
} from "./computer-location";

describe("computer location copy", () => {
  it("distinguishes the Razer runtime from the physical Mac", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "remote", serverName: "Razer" },
      host: {
        ...browserDesktopCapabilities().host,
        platform: "darwin",
        label: "macOS",
      },
    };
    expect(computerLocationCopy(capabilities)).toMatchObject({
      remote: true,
      serverName: "Razer",
      vmLabel: "Razer desktop",
      localLabel: "This Mac",
      localDestination: "this Mac",
      vmDestination: "the private desktop on Razer",
    });
  });

  it("keeps ordinary local installs generic", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "local" },
      host: {
        ...browserDesktopCapabilities().host,
        platform: "linux",
        label: "Linux",
      },
    };
    expect(computerLocationCopy(capabilities)).toMatchObject({
      remote: false,
      vmLabel: "Private desktop",
      localLabel: "This computer",
    });
  });

  it("names a remote Windows controller without moving the Razer runtime", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "remote", serverName: "Razer" },
      host: {
        ...browserDesktopCapabilities().host,
        platform: "win32",
        label: "Windows",
      },
    };
    expect(computerLocationCopy(capabilities)).toMatchObject({
      remote: true,
      serverName: "Razer",
      vmLabel: "Razer desktop",
      localLabel: "This Windows PC",
      localDestination: "this Windows PC",
    });
  });

  it("does not call a separate hosted computer the remote server", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "remote", serverName: "Razer" },
      host: { ...browserDesktopCapabilities().host, platform: "darwin", label: "macOS" },
    };
    const copy = computerLocationCopy(capabilities);
    const context = {
      platform: "darwin" as const,
      autoPhysicalFallbackAvailable: true,
      autoStartVps: false,
      computerEngine: false,
      localVmMode: "per-bot" as const,
    };
    expect(computerDestinationLabel("cloud", copy, "box")).toBe("Hosted Box");
    expect(computerDestinationLabel("cloud", copy, "vps")).toBe("Remote VPS");
    expect(computerDestinationDescription("cloud", copy, "box", context)).toContain("separate from Razer");
    expect(computerDestinationDescription("vm", copy, "box", context)).toContain("isolated Linux desktop on Razer");
    expect(computerDestinationDescription("local", copy, "box", context)).toContain("main AI session and workspace stay on Razer");
  });

  it("describes Automatic without promising an unavailable physical fallback", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "remote", serverName: "Razer" },
      host: { ...browserDesktopCapabilities().host, platform: "linux", label: "Linux" },
    };
    const copy = computerLocationCopy(capabilities);
    const description = computerDestinationDescription("auto", copy, "vps", {
      platform: "linux",
      autoPhysicalFallbackAvailable: false,
      autoStartVps: true,
      computerEngine: false,
      localVmMode: "shared",
    });
    expect(description).toContain("may create or wake");
    expect(description).toContain("desktop-control tools stay off");
    expect(description).not.toContain("otherwise uses this computer");
  });

  it("states when the Computer engine itself depends on Hosted Box", () => {
    const capabilities: DesktopCapabilities = {
      ...browserDesktopCapabilities(),
      connection: { mode: "remote", serverName: "Razer" },
    };
    const copy = computerLocationCopy(capabilities);
    const context = {
      platform: "linux" as const,
      autoPhysicalFallbackAvailable: false,
      autoStartVps: false,
      computerEngine: true,
      localVmMode: "shared" as const,
    };
    expect(computerDestinationDescription("cloud", copy, "box", context)).toContain("engine, desktop, shell, and disk");
    expect(computerDestinationDescription("off", copy, "box", context)).toContain("cannot run");
    expect(computerDestinationDescription("auto", copy, "vps", context)).toContain("cannot use Remote VPS");
    expect(computerDestinationDescription("cloud", copy, "vps", context)).toContain("Select Hosted Box");
  });

  it("never recommends the Computer engine for Remote VPS", () => {
    expect(unsupportedHostedDestinationMessage("vps")).toContain("select Hosted Box");
    expect(unsupportedHostedDestinationMessage("vps")).not.toContain("Computer engine");
    expect(unsupportedHostedDestinationMessage("box")).toContain("Computer engine");
  });
});
