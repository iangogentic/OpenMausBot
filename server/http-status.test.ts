import { describe, expect, it } from "vitest";

import { httpStatusForError } from "./http-status.ts";

describe("httpStatusForError", () => {
  it("preserves only real HTTP error statuses", () => {
    expect(httpStatusForError({ status: 400 })).toBe(400);
    expect(httpStatusForError({ status: 599 })).toBe(599);
  });

  it("maps child-process exit codes and malformed values to 500", () => {
    expect(httpStatusForError({ status: 69 })).toBe(500);
    expect(httpStatusForError({ status: 600 })).toBe(500);
    expect(httpStatusForError({ status: "409" })).toBe(500);
    expect(httpStatusForError(new Error("boom"))).toBe(500);
  });
});
