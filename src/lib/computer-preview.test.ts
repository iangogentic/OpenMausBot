import { describe, expect, it } from "vitest";

import {
  frameMatchesPreviewTarget,
  historicalFrameMatchesPreviewTarget,
  newestPreviewFrame,
  previewFreshness,
} from "./computer-preview";

describe("computer preview", () => {
  it("chooses the newest capture instead of privileging SSE", () => {
    const oldSse = { source: "sse", at: 100 };
    const freshPoll = { source: "poll", at: 200 };
    expect(newestPreviewFrame([oldSse, freshPoll])).toBe(freshPoll);
    expect(newestPreviewFrame([freshPoll, oldSse])).toBe(freshPoll);
  });

  it("marks working previews stale quickly and idle previews less aggressively", () => {
    expect(previewFreshness(1_000, 14_000, true).stale).toBe(true);
    expect(previewFreshness(1_000, 14_000, false).stale).toBe(false);
    expect(previewFreshness(12_500, 14_000, true).label).toBe("Live · now");
  });

  it("rejects frames from an old target or old generation on the same target", () => {
    const current = { targetKey: "vm:new", targetGeneration: "turn-b" };
    expect(frameMatchesPreviewTarget(current, "vm:new", "turn-b")).toBe(true);
    expect(frameMatchesPreviewTarget(current, "vm:old", "turn-b")).toBe(false);
    expect(frameMatchesPreviewTarget(current, "vm:new", "turn-a")).toBe(false);
    expect(frameMatchesPreviewTarget(current, null, null)).toBe(false);
  });

  it("uses last-known history only while idle and requires the active generation while busy", () => {
    const prior = { targetKey: "box:ada", targetGeneration: "turn-a" };
    expect(historicalFrameMatchesPreviewTarget(prior, "box:ada", null)).toBe(true);
    expect(historicalFrameMatchesPreviewTarget(prior, "box:ada", "turn-a")).toBe(true);
    expect(historicalFrameMatchesPreviewTarget(prior, "box:ada", "turn-b")).toBe(false);
    expect(historicalFrameMatchesPreviewTarget(prior, "box:grace", null)).toBe(false);
  });
});
