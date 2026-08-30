import { describe, expect, it } from "vitest";

import { TurnScopedSnapshots } from "./turn-scoped-snapshots.ts";

const turn = (generation: string) => ({
  botId: "bot-a",
  threadId: "thread-a",
  generation,
});

describe("turn-scoped trusted snapshots", () => {
  it("keeps the first source immutable for one exact turn", () => {
    const snapshots = new TurnScopedSnapshots<{ url: string; key: string }>();
    const first = snapshots.capture(turn("generation-a"), { url: "http://one", key: "key-one" });
    const rotated = snapshots.capture(turn("generation-a"), { url: "http://two", key: "key-two" });

    expect(rotated).toBe(first);
    expect(snapshots.get(turn("generation-a"))).toEqual({ url: "http://one", key: "key-one" });
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("isolates generations and erases only the finished turn", () => {
    const snapshots = new TurnScopedSnapshots<{ key: string }>();
    snapshots.capture(turn("generation-a"), { key: "key-a" });
    snapshots.capture(turn("generation-b"), { key: "key-b" });

    expect(snapshots.finish(turn("generation-a"))).toBe(true);
    expect(snapshots.get(turn("generation-a"))).toBeNull();
    expect(snapshots.get(turn("generation-b"))).toEqual({ key: "key-b" });
    expect(snapshots.size).toBe(1);
  });
});
