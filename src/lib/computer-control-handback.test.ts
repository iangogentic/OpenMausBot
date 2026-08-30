import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computerHandbackInProgress,
  handBackComputerControl,
  onComputerHandbackState,
} from "./computer-control-handback";

function viewer(open = true) {
  const states = new Map<string, boolean>([
    ["bot-a", open],
    ["bot-b", false],
  ]);
  return {
    states,
    currentState: vi.fn(async (contextId: string) => ({
      open: states.get(contextId) === true,
      contextId,
    })),
    close: vi.fn(async (contextId: string) => {
      if (states.get(contextId) !== true) return false;
      states.set(contextId, false);
      return true;
    }),
  };
}

describe("computer control hand-back", () => {
  afterEach(() => vi.restoreAllMocks());

  it("closes and confirms the Electron viewer before releasing bot input", async () => {
    const order: string[] = [];
    const desktop = viewer();
    desktop.close.mockImplementation(async () => {
      order.push("close-desktop");
      desktop.states.set("bot-a", false);
      return true;
    });
    await handBackComputerControl({
      botId: "bot-a",
      desktopViewer: desktop,
      release: async () => { order.push("release"); },
      closeBrowserViewer: () => order.push("close-browser"),
    });
    expect(order).toEqual(["close-desktop", "release", "close-browser"]);
  });

  it("keeps the lease held when an owned hosted viewer cannot be closed", async () => {
    const desktop = viewer();
    desktop.close.mockResolvedValue(false);
    const release = vi.fn();
    await expect(handBackComputerControl({
      botId: "bot-a",
      desktopViewer: desktop,
      release,
      closeBrowserViewer: vi.fn(),
    })).rejects.toThrow(/still paused/);
    expect(release).not.toHaveBeenCalled();
    expect(computerHandbackInProgress("bot-a")).toBe(false);
  });

  it("signals synchronously so an in-flight desktop join can abort", async () => {
    const states: boolean[] = [];
    const off = onComputerHandbackState((botId, active) => {
      if (botId === "bot-a") states.push(active);
    });
    await handBackComputerControl({
      botId: "bot-a",
      release: async () => {
        expect(computerHandbackInProgress("bot-a")).toBe(true);
      },
      closeBrowserViewer: vi.fn(),
    });
    off();
    expect(states).toEqual([true, false]);
  });

  it("never closes another bot's Electron viewer", async () => {
    const desktop = viewer();
    desktop.states.set("bot-a", false);
    desktop.states.set("bot-b", true);
    await handBackComputerControl({
      botId: "bot-a",
      desktopViewer: desktop,
      release: vi.fn(async () => {}),
      closeBrowserViewer: vi.fn(),
    });
    expect(desktop.close).not.toHaveBeenCalled();
    expect(desktop.states.get("bot-b")).toBe(true);
    expect(desktop.currentState).toHaveBeenCalledWith("bot-a");
  });
});
