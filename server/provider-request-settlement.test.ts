import { describe, expect, it, vi } from "vitest";

import { ProviderRequestSettlements } from "./provider-request-settlement.ts";

describe("provider request settlement serialization", () => {
  it("delivers exactly the first response when Allow races a Never denial", async () => {
    const settlements = new ProviderRequestSettlements<string, object, "allow" | "deny", string>();
    const generation = {};
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const allowDelivery = vi.fn(async () => {
      await gate;
      return "allowed-once";
    });
    const denyDelivery = vi.fn(async () => "rejected");

    const allowing = settlements.settle("thread:request", generation, "allow", allowDelivery);
    const denying = settlements.settle("thread:request", generation, "deny", denyDelivery);
    release();

    await expect(Promise.all([allowing, denying])).resolves.toEqual(["allowed-once", "allowed-once"]);
    expect(allowDelivery).toHaveBeenCalledTimes(1);
    expect(denyDelivery).not.toHaveBeenCalled();
    expect(settlements.get("thread:request")?.behavior).toBe("allow");
  });

  it("does not let an old generation lock a reused provider request id", async () => {
    const settlements = new ProviderRequestSettlements<string, object, "allow" | "deny", string>();
    const oldGeneration = {};
    const newGeneration = {};
    await settlements.settle("thread:request", oldGeneration, "deny", async () => "old-denied");
    await expect(
      settlements.settle("thread:request", newGeneration, "allow", async () => "new-allowed"),
    ).resolves.toBe("new-allowed");
  });
});
