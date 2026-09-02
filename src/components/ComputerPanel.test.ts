import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { cloudComputerRemovalConfirmation } from "../lib/cloud-computer-removal";
import {
  clearComputerLease,
  computerPanelLeaseToken,
  writeComputerLease,
} from "../lib/computer-control-lease";
import {
  collapseComputerPanel,
  escapeClosesComputerPanel,
} from "../lib/computer-panel-navigation";

afterEach(() => {
  clearComputerLease("bot-a");
  clearComputerLease("bot-b");
});

describe("computer panel session identity", () => {
  it("restores only the selected bot's exact lease when switching sessions", () => {
    writeComputerLease("bot-a", { ownerId: "renderer-a", leaseToken: "lease-a" });
    writeComputerLease("bot-b", { ownerId: "renderer-a", leaseToken: "lease-b" });

    expect(computerPanelLeaseToken("bot-a", "renderer-a")).toBe("lease-a");
    expect(computerPanelLeaseToken("bot-b", "renderer-a")).toBe("lease-b");
  });

  it("never treats another renderer's lease as this panel's control", () => {
    writeComputerLease("bot-a", { ownerId: "renderer-other", leaseToken: "foreign" });
    expect(computerPanelLeaseToken("bot-a", "renderer-a")).toBeNull();
  });
});

describe("computer panel collapse interactions", () => {
  it.each(["checking", "computer", "android", "error", "control-held"])(
    "explicitly closes from the %s view",
    () => {
      const dispatch = vi.fn();
      collapseComputerPanel(dispatch);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith({ type: "toggleComputer", open: false });
    },
  );

  it("closes on Escape except while a child editor or warning owns Escape", () => {
    const ordinary = {
      key: "Escape",
      defaultPrevented: false,
      routineEditorOpen: false,
      warningOpen: false,
    };
    expect(escapeClosesComputerPanel(ordinary)).toBe(true);
    expect(escapeClosesComputerPanel({ ...ordinary, defaultPrevented: true })).toBe(false);
    expect(escapeClosesComputerPanel({ ...ordinary, routineEditorOpen: true })).toBe(false);
    expect(escapeClosesComputerPanel({ ...ordinary, warningOpen: true })).toBe(false);
    expect(escapeClosesComputerPanel({ ...ordinary, key: "Enter" })).toBe(false);
  });
});

describe("computer panel viewport ownership", () => {
  it("keeps operator sessions inside the selected bot's scrolling computer view", () => {
    const source = readFileSync(new URL("./ComputerPanel.tsx", import.meta.url), "utf8");
    const scrollOwner = source.indexOf('cn("flex-1 overflow-y-auto px-5"');
    const operatorStrip = source.indexOf("<ComputerChildMonitorStrip", scrollOwner);
    const screenPreview = source.indexOf("{/* Screen preview */}", operatorStrip);

    expect(scrollOwner).toBeGreaterThan(-1);
    expect(operatorStrip).toBeGreaterThan(scrollOwner);
    expect(screenPreview).toBeGreaterThan(operatorStrip);
  });

  it("keeps destination configuration out of the live computer viewer", () => {
    const computerPanel = readFileSync(new URL("./ComputerPanel.tsx", import.meta.url), "utf8");
    const agentProfile = readFileSync(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
    const hostedPicker = readFileSync(new URL("./CloudBackendPicker.tsx", import.meta.url), "utf8");

    expect(computerPanel).not.toContain("Computer tools act on");
    expect(computerPanel).not.toContain("<CloudBackendPicker");
    expect(computerPanel).not.toContain("Enable Start VPS automatically below");
    expect(computerPanel).not.toContain('"cloud computer"');
    expect(computerPanel).toContain("hostedDestinationLabel");
    expect(agentProfile).toContain("Controlled desktop");
    expect(agentProfile).toContain("computerDestinationDescription");
    expect(agentProfile).toContain("w-[min(400px,100vw)]");
    expect(agentProfile).toContain("max-md:absolute");
    expect(hostedPicker).toContain("aria-pressed={value === backend}");
  });
});

describe("cloud computer destructive confirmations", () => {
  it("makes hosted Box deletion, data loss, and non-recreation explicit", () => {
    const copy = cloudComputerRemovalConfirmation("box", "Scout");

    expect(copy).toMatch(/Permanently delete Scout's hosted Box/i);
    expect(copy).toMatch(/every file and browser session/i);
    expect(copy).toMatch(/cannot be undone/i);
    expect(copy).toMatch(/turned Off.*does not recreate/i);
  });

  it("distinguishes removing the managed container from deleting the VPS", () => {
    const copy = cloudComputerRemovalConfirmation("vps", "Scout");

    expect(copy).toMatch(/Remove Scout's managed VPS container/i);
    expect(copy).toMatch(/permanently erases files stored only inside/i);
    expect(copy).toMatch(/does not delete the VPS itself/i);
    expect(copy).toMatch(/turned Off.*does not recreate/i);
  });
});
