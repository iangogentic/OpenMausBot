import { describe, expect, it, vi } from "vitest";
import { finishRuntimeWithRetainedOwner } from "./runtime-owner-release.ts";

describe("runtime owner terminal ordering", () => {
  it("keeps exact provider ownership visible to synchronous finished listeners", () => {
    const owners = new Map([["turn", "provider-runtime-turn"]]);
    const cancelParent = vi.fn();
    const result = finishRuntimeWithRetainedOwner(
      () => {
        cancelParent(owners.get("turn"));
        return "finished";
      },
      () => owners.delete("turn"),
    );
    expect(result).toBe("finished");
    expect(cancelParent).toHaveBeenCalledWith("provider-runtime-turn");
    expect(owners.has("turn")).toBe(false);
  });
});
