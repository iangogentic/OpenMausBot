import { describe, expect, it } from "vitest";

import { ensureStorageLeafSync, retireStorageLeaf, storageLeafArguments } from "./storage-leaf.ts";

describe("bounded storage leaf authority", () => {
  it("builds only exact fixed helper operations", () => {
    expect(storageLeafArguments("ensure", "workspace", "bot_A-1")).toEqual([
      "--ensure-workspace",
      "bot_A-1",
    ]);
    expect(storageLeafArguments("retire", "vm", "0123456789abcdef")).toEqual([
      "--retire-vm",
      "0123456789abcdef",
    ]);
    expect(storageLeafArguments("ensure", "vm", "shared")).toEqual(["--ensure-vm", "shared"]);
  });

  it.each([
    ["workspace", "../server"],
    ["workspace", "a/b"],
    ["workspace", ""],
    ["vm", "SHARED"],
    ["vm", "0123"],
    ["vm", "../../0123456789abcdef"],
  ] as const)("rejects an unsafe %s key", (kind, key) => {
    expect(() => storageLeafArguments("ensure", kind, key)).toThrow(/invalid/);
  });

  it("is a compatibility no-op when hardened storage is not configured", async () => {
    expect(() => ensureStorageLeafSync("workspace", "bot-1", {})).not.toThrow();
    await expect(retireStorageLeaf("workspace", "bot-1", {})).resolves.toBeUndefined();
  });

  it("fails closed when hardened storage is required without a helper", async () => {
    const startup = { OMB_REQUIRE_STORAGE_ISOLATION: "1" };
    expect(() => ensureStorageLeafSync("workspace", "bot-1", startup)).toThrow(/requires/);
    await expect(retireStorageLeaf("workspace", "bot-1", startup)).rejects.toThrow(/requires/);
  });
});
