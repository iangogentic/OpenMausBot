import { describe, expect, it, vi } from "vitest";

import { _queuedChannelCount, drainChannelMessages, queueChannelMessage } from "./channel-queue.ts";

describe("channel queue", () => {
  it("keeps messages off a running channel and drains one follow-up at a time", () => {
    let working = true;
    const run = vi.fn(() => { working = true; });
    queueChannelMessage("group-a", "thread-a", "first follow-up");
    queueChannelMessage("group-a", "thread-a", "second follow-up");

    drainChannelMessages(() => working, run);
    expect(run).not.toHaveBeenCalled();
    expect(_queuedChannelCount("thread-a")).toBe(2);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ text: "first follow-up" }));
    expect(_queuedChannelCount("thread-a")).toBe(1);

    working = false;
    drainChannelMessages(() => working, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ text: "second follow-up" }));
    expect(_queuedChannelCount("thread-a")).toBe(0);
  });
});
