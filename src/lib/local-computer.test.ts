import { describe, expect, it } from "vitest";
import type { Bot, InstanceInfo } from "@/state/store";
import {
  autoSelectsLocalComputer,
  instanceSupportsAutoPhysicalFallback,
  instanceSupportsLocalComputer,
  linuxAutoDescription,
  localComputerDisabledReason,
  localComputerSelectable,
  missingHostedBoxAction,
} from "./local-computer";

describe("local computer UI eligibility", () => {
  it("requires the selected instance to advertise approval-capable local MCP", () => {
    const bot = {
      modelSelection: { instanceId: "claude", model: "test" },
    } satisfies Pick<Bot, "modelSelection">;
    const instances = [
      {
        instanceId: "claude",
        capabilities: { localComputerMcp: true },
      },
    ] satisfies Array<Pick<InstanceInfo, "instanceId" | "capabilities">>;
    expect(instanceSupportsLocalComputer(instances as InstanceInfo[], bot)).toBe(true);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: {} }] as InstanceInfo[],
        bot,
      ),
    ).toBe(false);
    expect(
      instanceSupportsLocalComputer(
        [{ ...instances[0], capabilities: { computerMcp: true } }] as InstanceInfo[],
        bot,
      ),
    ).toBe(true);
  });

  it("does not mistake general computer or operator support for Automatic physical fallback", () => {
    const bot = { modelSelection: { instanceId: "engine", model: "test" } } satisfies Pick<Bot, "modelSelection">;
    const instance = (capabilities: InstanceInfo["capabilities"]) => [{
      instanceId: "engine",
      capabilities,
    }] as InstanceInfo[];
    expect(instanceSupportsAutoPhysicalFallback(instance({ computerMcp: true }), bot)).toBe(false);
    expect(instanceSupportsAutoPhysicalFallback(instance({ localComputerMcp: true }), bot)).toBe(true);
  });

  it("keeps This computer selectable on macOS before CUA is granted", () => {
    const capabilities = {
      host: { platform: "darwin" as const },
      localComputer: { available: false },
    } as DesktopCapabilities;
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: true })).toBe(true);
    expect(localComputerSelectable({ capabilities, providerSupportsLocal: false })).toBe(false);
    expect(
      localComputerSelectable({
        capabilities: {
          host: { platform: "linux" as const },
          localComputer: { available: false },
        } as DesktopCapabilities,
        providerSupportsLocal: true,
      }),
    ).toBe(false);
  });

  it("states that Linux Auto never selects this computer", () => {
    expect(linuxAutoDescription()).toContain("otherwise computer use stays off");
    expect(
      autoSelectsLocalComputer({
        platform: "linux",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("explains the Wayland seat-safety block and names the supported session", () => {
    const capabilities = {
      host: { platform: "linux" as const },
      localComputer: {
        available: false,
        enabled: false,
        reasonCode: "linux-wayland-seat-safety-blocked",
      },
    } as DesktopCapabilities;

    expect(
      localComputerDisabledReason({ capabilities, providerSupportsLocal: true }),
    ).toBe(
      "Local computer control is not available on Wayland yet. Sign out and choose Ubuntu on Xorg to use This computer.",
    );
  });

  it("preserves the ready local fallback on supported non-Linux hosts", () => {
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: undefined,
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(true);
    expect(
      autoSelectsLocalComputer({
        platform: "darwin",
        computer: "cloud",
        capabilitiesReady: true,
        localSelectable: true,
      }),
    ).toBe(false);
  });

  it("never provisions a missing Hosted Box for an ordinary bot in Automatic mode", () => {
    expect(missingHostedBoxAction({ computer: undefined, computerEngine: false, physicalFallbackAvailable: true })).toBe("physical");
    expect(missingHostedBoxAction({ computer: undefined, computerEngine: false, physicalFallbackAvailable: false })).toBe("off");
  });

  it("provisions a missing Box only when explicitly selected or required by the Computer engine", () => {
    expect(missingHostedBoxAction({ computer: "cloud", computerEngine: false, physicalFallbackAvailable: false })).toBe("provision");
    expect(missingHostedBoxAction({ computer: undefined, computerEngine: true, physicalFallbackAvailable: false })).toBe("provision");
  });
});
