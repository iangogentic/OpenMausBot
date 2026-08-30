import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_SESSION_DIRECT_LIMIT,
  computerSessionThumbnailSrc,
  deriveComputerSessions,
  nextComputerSessionFocusIndex,
  openComputerSession,
} from "./computer-session-strip";
import type { Bot } from "@/state/store";

const now = 1_900_000_000_000;

function bot(id: string, patch: Partial<Bot> = {}): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name: id.toUpperCase(),
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "test", model: "test" },
    messages: [],
    ...patch,
  };
}

function screen(png: string, at = now) {
  return {
    png,
    mime: "image/png",
    at,
    targetKey: `target-${png}`,
    targetGeneration: `generation-${png}`,
  };
}

describe("computer session derivation", () => {
  it("keeps the selected bot first, prioritizes held and working peers, and preserves exact bot/frame ownership", () => {
    const screens = {
      selected: screen("U0VMRUNURUQ="),
      held: screen("SEVMRA==", now - 2_000),
      working: screen("V09SS0lORw==", now - 1_000),
      recent: screen("UkVDRU5U", now - 500),
    };
    const sessions = deriveComputerSessions({
      bots: [bot("recent"), bot("working", { busy: true }), bot("held"), bot("selected")],
      screens,
      computerControl: { held: { held: true, helpReason: null } },
      selectedBotId: "selected",
      now,
    });

    expect(sessions.map((session) => session.bot.id)).toEqual(["selected", "held", "working", "recent"]);
    for (const session of sessions) expect(session.screen).toBe(screens[session.bot.id as keyof typeof screens]);
    expect(sessions).toHaveLength(COMPUTER_SESSION_DIRECT_LIMIT);
  });

  it("includes selected, held, busy, and recent-screen bots but drops unrelated and expired peers", () => {
    const sessions = deriveComputerSessions({
      bots: [
        bot("selected"),
        bot("held"),
        bot("busy", { busy: true }),
        bot("recent"),
        bot("expired"),
        bot("unrelated"),
        bot("off-busy", { busy: true, computer: "off" }),
      ],
      screens: {
        recent: screen("UkVDRU5U"),
        expired: screen("RVhQSVJFRA==", now - 10 * 60_000),
      },
      computerControl: { held: { held: true, helpReason: "take over" } },
      selectedBotId: "selected",
      now,
    });

    expect(sessions.map((session) => session.bot.id)).toEqual(["selected", "held", "busy", "recent"]);
  });

  it("builds only fenced raster data URLs", () => {
    expect(computerSessionThumbnailSrc(screen("UE5H"))).toBe("data:image/png;base64,UE5H");
    expect(computerSessionThumbnailSrc({ ...screen("PHN2Zz4="), mime: "image/svg+xml" })).toBeNull();
    expect(computerSessionThumbnailSrc({ ...screen("UE5H"), targetGeneration: "" })).toBeNull();
    expect(computerSessionThumbnailSrc({ ...screen("https://controller.local/private"), mime: "image/png" })).toBeNull();
  });
});

describe("computer session navigation", () => {
  it("dispatches select before opening the panel and never emits a lease action", () => {
    const dispatch = vi.fn();
    openComputerSession(dispatch, "bot-b");
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-b" },
      { type: "toggleComputer", open: true },
    ]);
  });

  it("supports wrapping arrow navigation plus Home and End", () => {
    expect(nextComputerSessionFocusIndex(0, "ArrowLeft", 5)).toBe(4);
    expect(nextComputerSessionFocusIndex(4, "ArrowRight", 5)).toBe(0);
    expect(nextComputerSessionFocusIndex(2, "ArrowDown", 5)).toBe(3);
    expect(nextComputerSessionFocusIndex(2, "ArrowUp", 5)).toBe(1);
    expect(nextComputerSessionFocusIndex(3, "Home", 5)).toBe(0);
    expect(nextComputerSessionFocusIndex(0, "End", 5)).toBe(4);
    expect(nextComputerSessionFocusIndex(0, "Enter", 5)).toBeNull();
  });
});
