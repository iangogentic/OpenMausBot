import { describe, expect, it, vi } from "vitest";

import { firstResponseDeadline } from "./first-response-deadline.ts";

describe("first response deadline", () => {
  it("fails a relay that never returns its first response", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      firstResponseDeadline(expired, 6_000);
      await vi.advanceTimersByTimeAsync(5_999);
      expect(expired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(expired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("is cancelled by the first response", async () => {
    vi.useFakeTimers();
    try {
      const expired = vi.fn();
      const cancel = firstResponseDeadline(expired, 6_000);
      cancel();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(expired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
