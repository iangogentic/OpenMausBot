import { describe, expect, it } from "vitest";

import { assignmentUsesLocalVm, resolveComputerAssignment } from "./computer-destination-policy.ts";

describe("computer destination policy", () => {
  it("routes Automatic to the bot's isolated VM in per-bot mode", () => {
    expect(resolveComputerAssignment(undefined, "per-bot")).toBe("vm");
    expect(assignmentUsesLocalVm(undefined, "per-bot")).toBe(true);
  });

  it("preserves legacy Automatic fallback in shared mode", () => {
    expect(resolveComputerAssignment(undefined, "shared")).toBeUndefined();
    expect(assignmentUsesLocalVm(undefined, "shared")).toBe(false);
  });

  it("keeps explicit choices and cloud routine overrides authoritative", () => {
    expect(resolveComputerAssignment("local", "per-bot")).toBe("local");
    expect(resolveComputerAssignment("off", "per-bot")).toBe("off");
    expect(resolveComputerAssignment("vm", "per-bot", true)).toBe("cloud");
  });
});
