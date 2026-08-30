import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("production computer operator wiring", () => {
  it("mounts the dedicated surface only behind an explicit provider capability", () => {
    expect(source).toContain("instance.adapter.capabilities.computerOperatorMcp === true");
    expect(source).toMatch(/integrations\.computerOperator = computerOperatorIntegration[\s\S]*?computerKind = "vm-operator";[\s\S]*?} else \{[\s\S]*?integrations\.localComputer = scopedLocalVmComputer/);
    expect(source).toContain("You do not have direct computer tools");
  });

  it("fails closed onto the exact live desktop2 Qwen Hermes selection", () => {
    expect(source).toContain('inject?.host !== "desktop2_qwen"');
    expect(source).toContain('inject.model.toLowerCase() !== "qwen3.8-27b-abliterated"');
    expect(source).toContain('instance.driverKind !== "hermesAgent"');
    expect(source).toContain('snapshot?.state !== "available"');
    expect(source).toContain("a live Hermes bot configured for the desktop2 Qwen model is required");
  });

  it("authorizes the blocking route and accounts only child VM actions", () => {
    expect(source).toContain('path === "/api/internal/computer-operator"');
    expect(source).toContain('capabilityBinding?.kind !== "computer-operator"');
    expect(source).toContain("requireActionAccounting: Boolean(authority.computerSubagent)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.accountActions(authority.computerSubagent!, amount)");
  });

  it("fences final and preview images to the exact VM generation", () => {
    expect(source).toContain("computer operator VM generation changed before final screenshot");
    expect(source).toContain("the Local VM generation changed before preview capture");
    expect(source).toContain('createHash("sha256").update(bytes).digest("hex")');
    expect(source).toContain("imageDimensions(bytes, mimeType)");
  });

  it("cleans exact-turn contexts and aborts active children at turn finish", () => {
    expect(source).toContain('COMPUTER_OPERATOR_CONTEXTS.delete(`${turn.botId}\\0${turn.threadId}\\0${turn.generation}`)');
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.cancelParent(operatorParent)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.abort(active.handle)");
    expect(source).toContain("closeComputerOperatorChildTarget(childId, \"server shutting down\")");
  });
});
