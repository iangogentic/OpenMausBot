import { describe, expect, it, vi } from "vitest";

import { readBoundedResponseText } from "./bounded-response.ts";

describe("bounded HTTP response reader", () => {
  it("stops a streaming peer at the cap instead of buffering the full body", async () => {
    const cancelled = vi.fn();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Buffer.alloc(6, 0x61));
        if (pulls > 4) controller.close();
      },
      cancel: cancelled,
    });
    await expect(readBoundedResponseText(
      new Response(body),
      10,
      "too large",
    )).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalled();
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("rejects an impossible declared length before reading the body", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.from("small")); },
      cancel: cancelled,
    });
    await expect(readBoundedResponseText(
      new Response(body, { headers: { "content-length": "not-a-number" } }),
      10,
      "too large",
    )).rejects.toThrow("too large");
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
