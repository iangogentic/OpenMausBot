import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _clearChannelQueuesForTests,
  _queuedChannelCount,
  cancelChannelMessages,
  drainChannelMessages,
  MAX_QUEUED_CHANNEL_BYTES,
  MAX_QUEUED_CHANNEL_MESSAGES,
  MAX_QUEUED_CHANNEL_MESSAGES_PER_THREAD,
  pendingChannelMessageSnapshot,
  queueChannelMessage,
} from "./channel-queue.ts";

describe("channel queue", () => {
  afterEach(() => _clearChannelQueuesForTests());

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

  it("keeps a queued message when its synchronous start boundary throws", () => {
    queueChannelMessage("group-a", "thread-a", "do not lose me");

    expect(() => drainChannelMessages(() => false, () => {
      throw new Error("start failed");
    })).toThrow("start failed");

    expect(_queuedChannelCount("thread-a")).toBe(1);
    expect(pendingChannelMessageSnapshot()).toMatchObject([{
      groupId: "group-a",
      threadId: "thread-a",
      text: "do not lose me",
    }]);
  });

  it("cancels a room queue atomically while returning every user message", () => {
    const first = queueChannelMessage("group-a", "thread-a", "first");
    const second = queueChannelMessage("group-a", "thread-b", "second", { replyToId: "reply" });
    queueChannelMessage("group-b", "thread-c", "unrelated");

    expect(cancelChannelMessages("group-a")).toEqual([
      { threadId: "thread-a", queueId: first.id, text: "first" },
      { threadId: "thread-b", queueId: second.id, text: "second", replyToId: "reply" },
    ]);
    expect(_queuedChannelCount("thread-a")).toBe(0);
    expect(_queuedChannelCount("thread-b")).toBe(0);
    expect(_queuedChannelCount("thread-c")).toBe(1);
  });

  it("bounds each room and the process-wide queue", () => {
    for (let index = 0; index < MAX_QUEUED_CHANNEL_MESSAGES_PER_THREAD; index += 1) {
      queueChannelMessage("group-a", "thread-a", `room-${index}`);
    }
    expect(() => queueChannelMessage("group-a", "thread-a", "one too many"))
      .toThrow(/already has/);

    _clearChannelQueuesForTests();
    for (let index = 0; index < MAX_QUEUED_CHANNEL_MESSAGES; index += 1) {
      queueChannelMessage(`group-${index}`, `thread-${index}`, "x");
    }
    expect(() => queueChannelMessage("overflow", "overflow", "x")).toThrow(/queue is full/);
  });

  it("bounds aggregate queued text by UTF-8 bytes", () => {
    queueChannelMessage("group-a", "thread-a", "x".repeat(MAX_QUEUED_CHANNEL_BYTES));
    expect(() => queueChannelMessage("group-b", "thread-b", "y"))
      .toThrow(/text limit/);
  });
});
