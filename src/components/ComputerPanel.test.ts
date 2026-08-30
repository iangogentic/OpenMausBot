import { afterEach, describe, expect, it, vi } from "vitest";

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
