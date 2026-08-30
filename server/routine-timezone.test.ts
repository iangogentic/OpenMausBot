import { describe, expect, it } from "vitest";

import {
  nextZonedDailyOccurrence,
  normalizeTimeZone,
  zonedDailyOccurrences,
  zonedWallClockInstant,
} from "../shared/routine-timezone.ts";

describe("timezone-pinned routine scheduling", () => {
  it("uses the saved controller timezone instead of the server process timezone", () => {
    const after = Date.parse("2026-03-06T18:00:00Z");
    expect(nextZonedDailyOccurrence({
      time: "09:30",
      weekdays: [1],
      timeZone: "America/Chicago",
    }, after)).toBe(Date.parse("2026-03-09T14:30:00Z"));
    expect(nextZonedDailyOccurrence({
      time: "09:30",
      weekdays: [1],
      timeZone: "America/Los_Angeles",
    }, after)).toBe(Date.parse("2026-03-09T16:30:00Z"));
  });

  it("skips a nonexistent spring-forward wall time", () => {
    const after = Date.parse("2026-03-07T12:00:00Z");
    expect(nextZonedDailyOccurrence({
      time: "02:30",
      weekdays: [0],
      timeZone: "America/Chicago",
    }, after)).toBe(Date.parse("2026-03-15T07:30:00Z"));
  });

  it("runs a repeated fall-back minute only once", () => {
    const first = zonedWallClockInstant(2026, 11, 1, 1, 30, "America/Chicago");
    expect(first).toBe(Date.parse("2026-11-01T06:30:00Z"));
    expect(nextZonedDailyOccurrence({
      time: "01:30",
      weekdays: [0],
      timeZone: "America/Chicago",
    }, first!)).toBe(Date.parse("2026-11-08T07:30:00Z"));
  });

  it("enumerates a bounded calendar range and rejects invalid IANA zones", () => {
    expect(zonedDailyOccurrences({
      time: "09:00",
      weekdays: [1, 2, 3, 4, 5],
      timeZone: "UTC",
    }, Date.parse("2026-08-17T00:00:00Z"), Date.parse("2026-08-24T00:00:00Z"))).toHaveLength(5);
    expect(() => normalizeTimeZone("Mars/Olympus_Mons")).toThrow(/IANA timezone/);
  });
});
