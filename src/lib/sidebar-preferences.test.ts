import { describe, expect, it, vi } from "vitest";

import {
  SIDEBAR_LAST_EXPANDED_DENSITY_KEY,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_DENSITY_KEY,
  SIDEBAR_WIDTH_KEY,
  clampSidebarWidth,
  loadLastExpandedSidebarDensity,
  loadSidebarDensity,
  loadSidebarWidth,
  parseExpandedSidebarDensity,
  parseSidebarDensity,
  parseSidebarWidth,
  saveLastExpandedSidebarDensity,
  saveSidebarDensity,
  saveSidebarWidth,
  sidebarWidthForKey,
} from "./sidebar-preferences";

describe("sidebar density preferences", () => {
  it("accepts the three supported layouts and rejects stale values", () => {
    expect(parseSidebarDensity("comfortable")).toBe("comfortable");
    expect(parseSidebarDensity("compact")).toBe("compact");
    expect(parseSidebarDensity("icons")).toBe("icons");
    expect(parseSidebarDensity("tiny")).toBe("comfortable");
    expect(parseSidebarDensity(null)).toBe("comfortable");
  });

  it("loads and saves without making storage availability a launch dependency", () => {
    const setItem = vi.fn();
    saveSidebarDensity("icons", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_DENSITY_KEY, "icons");
    expect(loadSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });
});

describe("sidebar layout preferences", () => {
  it("remembers the last usable expanded density separately from collapse", () => {
    expect(parseExpandedSidebarDensity("compact")).toBe("compact");
    expect(parseExpandedSidebarDensity("icons")).toBe("comfortable");

    const setItem = vi.fn();
    saveLastExpandedSidebarDensity("compact", { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_LAST_EXPANDED_DENSITY_KEY, "compact");
    expect(loadLastExpandedSidebarDensity({ getItem: () => "compact" })).toBe("compact");
    expect(loadLastExpandedSidebarDensity({ getItem: () => { throw new Error("blocked"); } })).toBe("comfortable");
  });

  it("loads a persisted width, clamps bounds, and falls back from malformed storage", () => {
    expect(parseSidebarWidth("360")).toBe(360);
    expect(parseSidebarWidth("9999")).toBe(SIDEBAR_MAX_WIDTH);
    expect(parseSidebarWidth("1")).toBe(SIDEBAR_MIN_WIDTH);
    expect(parseSidebarWidth("not-a-number", 272)).toBe(272);
    expect(parseSidebarWidth(null, 272)).toBe(272);
    expect(clampSidebarWidth(319.6)).toBe(320);

    const setItem = vi.fn();
    saveSidebarWidth(9999, { setItem });
    expect(setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_KEY, String(SIDEBAR_MAX_WIDTH));
    expect(loadSidebarWidth({ getItem: () => "344" })).toBe(344);
    expect(loadSidebarWidth({ getItem: () => { throw new Error("blocked"); } }, 272)).toBe(272);
  });

  it("supports bounded keyboard resizing with larger Shift steps", () => {
    expect(sidebarWidthForKey(320, "ArrowLeft")).toBe(312);
    expect(sidebarWidthForKey(320, "ArrowRight", true)).toBe(352);
    expect(sidebarWidthForKey(320, "Home")).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(320, "End")).toBe(SIDEBAR_MAX_WIDTH);
    expect(sidebarWidthForKey(SIDEBAR_MIN_WIDTH, "ArrowLeft")).toBe(SIDEBAR_MIN_WIDTH);
    expect(sidebarWidthForKey(320, "Enter")).toBeNull();
  });
});
