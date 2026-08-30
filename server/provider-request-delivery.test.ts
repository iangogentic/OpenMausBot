import { describe, expect, it, vi } from "vitest";

import {
  deliverProviderRequestWithDeadline,
  timedOutRequestStillOwned,
} from "./provider-request-delivery.ts";

describe("bounded provider request delivery", () => {
  it("returns a provider acknowledgement before the deadline", async () => {
    await expect(deliverProviderRequestWithDeadline(async () => "allowed", 100)).resolves.toEqual({
      status: "returned",
      outcome: "allowed",
    });
  });

  it("times out a hung adapter deterministically", async () => {
    vi.useFakeTimers();
    try {
      const result = deliverProviderRequestWithDeadline(() => new Promise<string>(() => {}), 10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toEqual({ status: "timed-out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers only when the exact generation still owns the timed-out ask", () => {
    const timeout = { status: "timed-out" } as const;
    expect(timedOutRequestStillOwned(timeout, true)).toBe(true);
    expect(timedOutRequestStillOwned(timeout, false)).toBe(false);
    expect(timedOutRequestStillOwned({ status: "returned", outcome: "allowed" }, true)).toBe(false);
  });
});
