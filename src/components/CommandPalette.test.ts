import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { nextEnabledPaletteIndex } from "./CommandPalette";

const source = readFileSync(new URL("./CommandPalette.tsx", import.meta.url), "utf8");

describe("command palette keyboard selection", () => {
  it("skips disabled commands in both directions", () => {
    const enabled = [true, false, false, true];
    expect(nextEnabledPaletteIndex(enabled, 0, 1)).toBe(3);
    expect(nextEnabledPaletteIndex(enabled, 3, 1)).toBe(0);
    expect(nextEnabledPaletteIndex(enabled, 3, -1)).toBe(0);
    expect(nextEnabledPaletteIndex(enabled, 0, -1)).toBe(3);
  });

  it("has a stable fallback when every result is disabled or absent", () => {
    expect(nextEnabledPaletteIndex([false, false], 0, 1)).toBe(0);
    expect(nextEnabledPaletteIndex([], 0, -1)).toBe(0);
  });

  it("captures modal keys, traps Tab, and makes disabled rows natively unfocusable", () => {
    expect(source).toContain('window.addEventListener("keydown", onKey, true)');
    expect(source).toContain("event.stopImmediatePropagation()");
    expect(source).toContain('event.key === "Tab"');
    expect(source).toContain("dialogRef.current?.querySelectorAll<HTMLElement>");
    expect(source).toContain("disabled={disabled}");
    expect(source).toContain("tabIndex={disabled ? -1 : undefined}");
    expect(source).toContain("onFocus={() => !disabled && setCursor(index)}");
  });
});
