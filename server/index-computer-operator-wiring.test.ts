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
    expect(source).toContain("canonicalComputerOperatorModel(inject.host, inject.model)");
    expect(source).toContain("preflightComputerOperatorModel(");
    expect(source).toContain("model: canonicalModel");
    expect(source).toContain("input.model.model !== encodeInjectId(COMPUTER_OPERATOR_HOST_ID, COMPUTER_OPERATOR_MODEL_ID)");
    expect(source).toContain('instance.driverKind !== "hermesAgent"');
    expect(source).toContain('snapshot?.state !== "available"');
    expect(source).toContain("a live Hermes bot configured for the desktop2 Qwen model is required");
    expect(source).toContain('boundedComputerOperatorFailure("desktop2 Qwen readiness check failed", error)');
    expect(source).toContain("readinessFailure" + "}`)");
  });

  it("authorizes the blocking route and accounts only child VM actions", () => {
    expect(source).toContain('path === "/api/internal/computer-operator"');
    expect(source).toContain('capabilityBinding?.kind !== "computer-operator"');
    expect(source).toContain("requireActionAccounting: Boolean(authority.computerSubagent)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.accountActions(authority.computerSubagent!, amount)");
    expect(source).toContain("error instanceof ComputerOperatorRequestError || error instanceof SyntaxError");
    expect(source).toContain("return json(res, 409, { error: \"the computer operator request was cancelled\" })");
  });

  it("fences final and preview images to the exact VM generation", () => {
    expect(source).toContain("computer operator VM generation changed before final screenshot");
    expect(source).toContain("computer operator VM generation changed during final screenshot");
    expect(source.match(/currentContainerComputerGeneration\(capability\.runtime, capability\.target\)/g)).toHaveLength(2);
    expect(source).toContain("computer operator parent turn changed before final screenshot publication");
    expect(source).toContain("const captureAction = computerControl.beginAction(parent.botId, target.targetKey, capability.bridgeId)");
    expect(source).toContain("computer operator human control began during final screenshot");
    expect(source).toContain("computerControl.endAction(parent.botId, target.targetKey, capability.bridgeId, captureAction.actionId)");
    expect(source).toContain("the Local VM generation changed before preview capture");
    expect(source).toContain('createHash("sha256").update(bytes).digest("hex")');
    expect(source).toContain("imageDimensions(bytes, mimeType)");
  });

  it("routes approved outbound Mac or Windows targets through the operator with exact executor fencing", () => {
    expect(source).toContain("physicalComputerOperatorIntegration(");
    expect(source).toContain('kind: "physical-outbound"');
    expect(source).toContain("registration.executorGeneration !== context.executorGeneration");
    expect(source).toContain("PHYSICAL_BRIDGES.captureScreenshot(");
    expect(source).toContain("computer operator physical generation changed before final screenshot");
    expect(source).toContain("computer operator physical generation changed during final screenshot");
    expect(source).toContain("isolationKey: `computer-operator:${input.parent.botId}:${input.target.targetKey}`");
    expect(source).toContain("providerPrivateCwd: true");
    expect(source).not.toContain("cwd: ensureWorkspace(input.parent.botId)");
    expect(source).toContain("onFinalScreenshot: ({ childId, screenshot }) =>");
    expect(source).toContain("publishComputerChildFrame(childId");
    expect(source).toContain("the physical computer generation changed before preview capture");
    expect(source).toMatch(/previewCapture = async \(\) => \{[\s\S]*?PHYSICAL_BRIDGES\.captureScreenshot\(/);
    expect(source).toContain('scope: child ? "trusted-computer-operator" : "local-computer"');
    expect(source).toMatch(/if \(instance\.adapter\.capabilities\.computerOperatorMcp === true\)[\s\S]*?integrations\.computerOperator = physicalComputerOperatorIntegration/);
  });

  it("rejects an already-active parent before starting another child", () => {
    expect(source).toContain("reserveComputerOperator(ACTIVE_COMPUTER_OPERATORS, parentKey, () => {");
  });

  it("retires every deterministic hidden operator home with its bot", () => {
    expect(source).toContain("const operatorTargets = [perBotLocalVmTarget(botId).key, SHARED_LOCAL_VM_TARGET.key, \"physical:host\"]");
    expect(source).toContain("retireProviderOwnerState(`computer-operator:${botId}:${targetKey}`)");
  });

  it("pauses the delegated child on the global target even when takeover comes through another bot", () => {
    expect(source).toContain("pauseComputerOperatorForHuman(resolvedTargetKey)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.markWaitingOnHuman(active.handle, active.parent)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.resumeAfterHuman(active.handle, active.parent, () =>");
    expect(source).toContain("activeComputerOperatorForTarget(event.targetKey)");
    expect(source).toContain("activeComputerOperatorForTarget(targetKey) === active");
    expect(source).toContain("!computerControl.targetReservedForHuman(targetKey)");
    expect(source).not.toContain("active.parent.botId !== botId");
  });

  it("publishes trusted child frames and cursors with server-owned ordering", () => {
    expect(source).toContain("computerChildTelemetryCallbacks(authority.computerSubagent)");
    expect(source).toContain('broadcast({ kind: "computer-child-frame"');
    expect(source).toContain('broadcast({ kind: "computer-child-cursor"');
    expect(source).toContain("nextComputerChildVisualSeq(childId)");
    expect(source).toContain('timingSafeEqual(Buffer.from(frame.hash), Buffer.from(computedHash))');
    expect(source).toContain('kind !== "computer-child-frame"');
  });

  it("cleans exact-turn contexts and aborts active children at turn finish", () => {
    expect(source).toContain('COMPUTER_OPERATOR_CONTEXTS.delete(`${turn.botId}\\0${turn.threadId}\\0${turn.generation}`)');
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.cancelParent(operatorParent)");
    expect(source).toContain("COMPUTER_SUBAGENT_RUNTIME.abort(active.handle)");
    expect(source).toContain("closeComputerOperatorChildTarget(childId, \"server shutting down\")");
    expect(source).toMatch(/function finalizeVerifiedCancelledTurn[\s\S]*?PROVIDER_RUNTIME_TURN_IDS\.delete\(turnAttachmentHandoffKey\(turn\)\)/);
  });
});
