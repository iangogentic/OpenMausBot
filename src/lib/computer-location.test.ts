import { describe, expect, it } from "vitest";
import { browserDesktopCapabilities } from "./desktop";
import { computerLocationCopy } from "./computer-location";

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
      vmLabel: "Razer VM",
      localLabel: "This Mac",
      localDestination: "this Mac",
      vmDestination: "the Razer VM",
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
      vmLabel: "Local VM",
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
      vmLabel: "Razer VM",
      localLabel: "This Windows PC",
      localDestination: "this Windows PC",
    });
  });
});
