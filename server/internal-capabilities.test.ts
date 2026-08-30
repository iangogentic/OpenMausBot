import { describe, expect, it } from "vitest";

import {
  InternalCapabilityRegistry,
  InternalCapabilityTurns,
  internalCapabilityAllows,
  internalCapabilityScopeMatchesTarget,
} from "./internal-capabilities.ts";

describe("internal integration capabilities", () => {
  it("mints distinct agents and connector authority for the same turn", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const common = { botId: "bot-a", threadId: "thread-a", depth: 0, generation: "turn-a" };
    const agents = registry.register({ kind: "agents", ...common });
    const connectors = registry.register({ kind: "connectors", ...common });

    expect(agents.token).not.toBe(connectors.token);
    expect(agents).toMatchObject({ kind: "agents", ...common });
    expect(connectors).toMatchObject({ kind: "connectors", ...common });
    expect(Object.isFrozen(agents)).toBe(true);
  });

  it("allows only the exact route family and method carried by a token", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const agents = registry.register({
      kind: "agents",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    });
    const connectors = registry.register({
      kind: "connectors",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    });

    expect(registry.authorize(`Bearer ${agents.token}`, {
      method: "POST",
      path: "/api/internal/ask-bot",
    })).toBe(agents);
    expect(registry.authorize(`Bearer ${agents.token}`, {
      method: "POST",
      path: "/api/internal/connectors/mcp",
    })).toBeNull();
    expect(registry.authorize(`Bearer ${connectors.token}`, {
      method: "POST",
      path: "/api/internal/connectors/mcp",
    })).toBe(connectors);
    expect(registry.authorize(`Bearer ${connectors.token}`, {
      method: "GET",
      path: "/api/internal/connectors/mcp",
    })).toBeNull();
    expect(registry.authorize(`Bearer ${agents.token}`, {
      method: "POST",
      path: "/api/internal/not-a-route",
    })).toBeNull();
  });

  it("derives the allowlist from kind instead of caller-supplied scopes", () => {
    expect(internalCapabilityAllows("agents", { method: "GET", path: "/api/internal/agents" })).toBe(true);
    expect(internalCapabilityAllows("agents", { method: "POST", path: "/api/internal/connectors/request" })).toBe(false);
    expect(internalCapabilityAllows("connectors", { method: "POST", path: "/api/internal/connectors/request" })).toBe(true);
    expect(internalCapabilityAllows("connectors", { method: "POST", path: "/api/internal/request-credential" })).toBe(false);
    expect(internalCapabilityAllows("box", { method: "POST", path: "/api/internal/box" })).toBe(true);
    expect(internalCapabilityAllows("box", { method: "POST", path: "/api/internal/ian-brain/mcp" })).toBe(false);
    expect(internalCapabilityAllows("ian-brain", { method: "POST", path: "/api/internal/ian-brain/mcp" })).toBe(true);
    expect(internalCapabilityAllows("ian-brain", { method: "GET", path: "/api/internal/ian-brain/mcp" })).toBe(true);
    expect(internalCapabilityAllows("ian-brain", { method: "DELETE", path: "/api/internal/ian-brain/mcp" })).toBe(true);
    expect(internalCapabilityAllows("ian-brain", { method: "PUT", path: "/api/internal/ian-brain/mcp" })).toBe(false);
    expect(internalCapabilityAllows("local-vm", { method: "GET", path: "/api/internal/local-vm-computer/mcp" })).toBe(true);
    expect(internalCapabilityAllows("local-vm", { method: "GET", path: "/api/internal/physical-computer/mcp" })).toBe(false);
    expect(internalCapabilityAllows("model", { method: "GET", path: "/api/internal/model-relay" })).toBe(true);
    expect(internalCapabilityAllows("model", { method: "POST", path: "/api/internal/model-relay" })).toBe(true);
    expect(internalCapabilityAllows("model", { method: "POST", path: "/api/internal/box" })).toBe(false);
  });

  it("binds service capabilities to the exact bot, turn generation, and computer target", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `scoped-${++sequence}` });
    const binding = registry.register({
      kind: "box",
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      depth: 0,
      scope: { targetKey: "box:bot-a", resourceId: "ascii-box-a" },
    });
    expect(Object.isFrozen(binding.scope)).toBe(true);
    expect(internalCapabilityScopeMatchesTarget(binding, {
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      targetKey: "box:bot-a",
    })).toBe(true);
    expect(internalCapabilityScopeMatchesTarget(binding, {
      botId: "bot-b",
      threadId: "thread-a",
      generation: "generation-a",
      targetKey: "box:bot-a",
    })).toBe(false);
    expect(internalCapabilityScopeMatchesTarget(binding, {
      botId: "bot-a",
      threadId: "thread-a",
      generation: "stale-generation",
      targetKey: "box:bot-a",
    })).toBe(false);
    expect(internalCapabilityScopeMatchesTarget(binding, {
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      targetKey: "box:bot-b",
    })).toBe(false);
  });

  it("keeps no-computer Ian Brain authority valid only while no target is selected", () => {
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => "ian-cap" });
    const binding = registry.register({
      kind: "ian-brain",
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      depth: 0,
      scope: { targetKey: null, resourceId: "/home/a/.hermes" },
    });
    expect(internalCapabilityScopeMatchesTarget(binding, null)).toBe(true);
    expect(internalCapabilityScopeMatchesTarget(binding, {
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      targetKey: "physical:host",
    })).toBe(false);
  });

  it("rejects Local VM authority replayed across a bot, thread, target, or dispatch generation", () => {
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => "local-vm-cap" });
    const binding = registry.register({
      kind: "local-vm",
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      depth: 0,
      scope: { targetKey: "bot:target-a", resourceId: "a".repeat(64) },
    });
    const exact = {
      botId: "bot-a",
      threadId: "thread-a",
      generation: "generation-a",
      targetKey: "bot:target-a",
    };
    expect(internalCapabilityScopeMatchesTarget(binding, exact)).toBe(true);
    for (const mismatched of [
      { ...exact, botId: "bot-b" },
      { ...exact, threadId: "thread-b" },
      { ...exact, generation: "generation-b" },
      { ...exact, targetKey: "bot:target-b" },
    ]) {
      expect(internalCapabilityScopeMatchesTarget(binding, mismatched)).toBe(false);
    }
    expect(registry.authorize(`Bearer ${binding.token}`, {
      method: "GET",
      path: "/api/internal/physical-computer/mcp",
    })).toBeNull();
  });

  it("expires and prunes crashed-child authority", () => {
    let now = 1_000;
    const registry = new InternalCapabilityRegistry({
      tokenFactory: () => "short-lived",
      now: () => now,
      defaultTtlMs: 50,
    });
    const binding = registry.register({
      kind: "agents",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    });
    now = binding.expiresAtMs;

    expect(registry.authorize(`Bearer ${binding.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBeNull();
    expect(registry.size).toBe(0);

    now += 1;
    registry.register({
      kind: "connectors",
      botId: "bot-b",
      threadId: "thread-b",
      depth: 1,
      generation: "turn-b",
    });
    now += 51;
    expect(registry.pruneExpired()).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("revokes every integration family by exact turn and every turn by bot", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const turnA = { botId: "bot-a", threadId: "thread-a", depth: 0, generation: "turn-a" };
    const turnB = { botId: "bot-a", threadId: "thread-a", depth: 0, generation: "turn-b" };
    registry.register({ kind: "agents", ...turnA });
    registry.register({ kind: "connectors", ...turnA });
    registry.register({
      kind: "box",
      ...turnA,
      scope: { targetKey: "box:bot-a", resourceId: "box-a" },
    });
    registry.register({
      kind: "ian-brain",
      ...turnA,
      scope: { targetKey: "box:bot-a", resourceId: "/home/a/.hermes" },
    });
    registry.register({ kind: "agents", ...turnB });
    registry.register({
      kind: "agents",
      botId: "bot-b",
      threadId: "thread-b",
      depth: 0,
      generation: "turn-c",
    });

    expect(registry.revokeTurn(turnA)).toBe(4);
    expect(registry.size).toBe(2);
    expect(registry.revokeBot("bot-a")).toBe(1);
    expect(registry.size).toBe(1);
    expect(registry.revokeAll()).toBe(1);
    expect(registry.size).toBe(0);
  });

  it("invalidates an older child when the same integration remounts", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const input = {
      kind: "agents" as const,
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    };
    const oldBinding = registry.register(input);
    const currentBinding = registry.register(input);

    expect(registry.size).toBe(1);
    expect(registry.authorize(`Bearer ${oldBinding.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBeNull();
    expect(registry.authorize(`Bearer ${currentBinding.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBe(currentBinding);
  });

  it("namespaces parent and child mounts while revoking the complete turn", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `mount-${++sequence}` });
    const common = {
      kind: "local-vm" as const,
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
      scope: { targetKey: "bot:target-a", resourceId: "a".repeat(64) },
    };
    const parentMount = registry.register({ ...common, mountId: "primary" });
    const childMount = registry.register({ ...common, mountId: "computer-child:child-a" });

    expect(registry.size).toBe(2);
    expect(parentMount).toMatchObject({ mountId: "primary" });
    expect(childMount).toMatchObject({ mountId: "computer-child:child-a" });
    expect(registry.authorize(`Bearer ${parentMount.token}`, {
      method: "GET",
      path: "/api/internal/local-vm-computer/mcp",
    })).toBe(parentMount);
    expect(registry.authorize(`Bearer ${childMount.token}`, {
      method: "GET",
      path: "/api/internal/local-vm-computer/mcp",
    })).toBe(childMount);

    const replacementChild = registry.register({ ...common, mountId: "computer-child:child-a" });
    expect(registry.size).toBe(2);
    expect(registry.authorize(`Bearer ${childMount.token}`, {
      method: "GET",
      path: "/api/internal/local-vm-computer/mcp",
    })).toBeNull();
    expect(registry.authorize(`Bearer ${parentMount.token}`, {
      method: "GET",
      path: "/api/internal/local-vm-computer/mcp",
    })).toBe(parentMount);
    expect(registry.revokeTurn(common)).toBe(2);
    expect(registry.authorize(`Bearer ${replacementChild.token}`, {
      method: "GET",
      path: "/api/internal/local-vm-computer/mcp",
    })).toBeNull();
    expect(registry.size).toBe(0);
  });

  it("never reuses the old child's token while remounting", () => {
    const candidates = ["old-token", "old-token", "new-token"];
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => candidates.shift() ?? "fallback" });
    const input = {
      kind: "agents" as const,
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    };
    const oldBinding = registry.register(input);
    const currentBinding = registry.register(input);

    expect(oldBinding.token).toBe("old-token");
    expect(currentBinding.token).toBe("new-token");
    expect(registry.authorize("Bearer old-token", {
      method: "GET",
      path: "/api/internal/agents",
    })).toBeNull();
  });

  it("rejects malformed authority and invalid identity metadata", () => {
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => "token-a" });
    const binding = registry.register({
      kind: "agents",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    });
    const request = { method: "GET", path: "/api/internal/agents" };
    expect(registry.authorize(undefined, request)).toBeNull();
    expect(registry.authorize([`Bearer ${binding.token}`], request)).toBeNull();
    expect(registry.authorize(binding.token, request)).toBeNull();
    expect(registry.authorize(`Bearer ${binding.token} `, request)).toBeNull();
    expect(() => registry.register({
      kind: "agents",
      botId: "",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-b",
    })).toThrow(/botId/);
    expect(() => registry.register({
      kind: "agents",
      botId: "bot-a",
      threadId: "thread-a",
      depth: -1,
      generation: "turn-b",
    })).toThrow(/depth/);
  });

  it("keeps count quotas on the exact turn across bearer remounts", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const input = {
      kind: "agents" as const,
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    };
    const first = registry.register(input);
    expect(registry.consume(first, "create-bot", 2)).toBe(true);
    expect(registry.consume(first, "create-bot", 2)).toBe(true);
    expect(registry.consume(first, "create-bot", 2)).toBe(false);
    registry.revoke(first.token);
    expect(registry.consume(first, "create-bot", 2)).toBe(false);

    const remounted = registry.register(input);
    expect(registry.consume(remounted, "create-bot", 2)).toBe(false);
    registry.revokeTurn(input);
    const nextTurn = registry.register({ ...input, generation: "turn-b" });
    expect(registry.consume(nextTurn, "create-bot", 2)).toBe(true);
  });

  it("atomically caps parallel work and releases only the matching exact-turn lease", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `quota-${++sequence}` });
    const input = {
      kind: "box" as const,
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
      scope: { targetKey: "box:bot-a", resourceId: "box-a" },
    };
    const firstBinding = registry.register(input);
    const first = registry.acquire(firstBinding, "box-request", 3, 2);
    const second = registry.acquire(firstBinding, "box-request", 3, 2);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(registry.acquire(firstBinding, "box-request", 3, 2)).toEqual({
      ok: false,
      reason: "concurrency",
    });
    if (!first.ok || !second.ok) throw new Error("expected quota leases");

    first.release();
    first.release();
    const third = registry.acquire(firstBinding, "box-request", 3, 2);
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("expected third quota lease");
    second.release();
    expect(registry.acquire(firstBinding, "box-request", 3, 2)).toEqual({
      ok: false,
      reason: "count",
    });

    // Revocation immediately invalidates both the old bearer and its active
    // leases. Late, repeated releases remain harmless.
    registry.revokeTurn(input);
    expect(registry.acquire(firstBinding, "box-request", 3, 2)).toEqual({
      ok: false,
      reason: "revoked",
    });
    third.release();
  });

  it("reserves a parallel-safe batch ceiling before transcript mutation", () => {
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => "connector-quota" });
    const binding = registry.register({
      kind: "connectors",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "turn-a",
    });
    expect(registry.reserve(binding, "connector-cards", 12, 24)).toBe(true);
    expect(registry.reserve(binding, "connector-cards", 11, 24)).toBe(true);
    expect(registry.reserve(binding, "connector-cards", 2, 24)).toBe(false);
    expect(registry.reserve(binding, "connector-cards", 1, 24)).toBe(true);
  });

  it("keeps model byte/frame budgets isolated between sibling turns", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `model-${++sequence}` });
    const left = registry.register({
      kind: "model",
      botId: "bot-a",
      threadId: "thread-a",
      depth: 0,
      generation: "generation-a",
    });
    const right = registry.register({
      kind: "model",
      botId: "bot-b",
      threadId: "thread-b",
      depth: 0,
      generation: "generation-b",
    });
    expect(registry.reserve(left, "model-response-bytes", 8, 8)).toBe(true);
    expect(registry.reserve(left, "model-response-bytes", 1, 8)).toBe(false);
    expect(registry.reserve(right, "model-response-bytes", 8, 8)).toBe(true);
    expect(registry.reserve(left, "model-stream-frames", 2, 2)).toBe(true);
    expect(registry.reserve(right, "model-stream-frames", 2, 2)).toBe(true);
  });
});

describe("active internal integration turns", () => {
  it("rejects a well-formed token immediately after its exact turn settles", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `turn-token-${++sequence}` });
    const turns = new InternalCapabilityTurns(registry);
    const turn = turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-a" });
    const binding = turns.register("agents", turn, 0);
    const boxBinding = turns.register("box", turn, 0, {
      targetKey: "box:bot-a",
      resourceId: "box-a",
    });
    const request = { method: "GET", path: "/api/internal/agents" };

    expect(turns.authorize(`Bearer ${binding.token}`, request)).toBe(binding);
    expect(turns.finish(turn)).toBe(true);
    expect(turns.authorize(`Bearer ${binding.token}`, request)).toBeNull();
    expect(turns.authorize(`Bearer ${boxBinding.token}`, {
      method: "POST",
      path: "/api/internal/box",
    })).toBeNull();
  });

  it("correlates terminal events to their exact runtime turn", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const turns = new InternalCapabilityTurns(registry);
    const first = turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-a" });
    const firstToken = turns.register("agents", first, 0);
    expect(turns.bindRuntime("provider:thread-a:runtime-a", first)).toBe(true);
    expect(turns.finishRuntime("provider:thread-a:runtime-a")).toBe(first);

    const second = turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-b" });
    const secondToken = turns.register("agents", second, 0);
    expect(turns.finishRuntime("provider:thread-a:runtime-a")).toBeNull();
    expect(turns.authorize(`Bearer ${firstToken.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBeNull();
    expect(turns.authorize(`Bearer ${secondToken.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBe(secondToken);
  });

  it("rejects a successor without revoking the active bot or room owner", () => {
    let sequence = 0;
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => `token-${++sequence}` });
    const turns = new InternalCapabilityTurns(registry);
    const oldRoomTurn = turns.begin({ botId: "bot-a", threadId: "room-a", generation: "generation-a" });
    const oldToken = turns.register("agents", oldRoomTurn, 0);
    expect(() => turns.begin({ botId: "bot-b", threadId: "room-a", generation: "generation-b" })).toThrow(/already active/);
    expect(() => turns.begin({ botId: "bot-a", threadId: "other-room", generation: "generation-c" })).toThrow(/already active/);
    expect(() => turns.begin({ ...oldRoomTurn })).toThrow(/already active/);

    expect(turns.forBot("bot-a")).toBe(oldRoomTurn);
    expect(turns.forThread("room-a")).toBe(oldRoomTurn);
    expect(turns.authorize(`Bearer ${oldToken.token}`, {
      method: "GET",
      path: "/api/internal/agents",
    })).toBe(oldToken);

    expect(turns.finish(oldRoomTurn)).toBe(true);
    const successor = turns.begin({ botId: "bot-b", threadId: "room-a", generation: "generation-b" });
    expect(turns.forThread("room-a")).toBe(successor);
  });

  it("binds runtime ids only to the exact current dispatch generation", () => {
    const registry = new InternalCapabilityRegistry({ tokenFactory: () => "unused" });
    const turns = new InternalCapabilityTurns(registry);
    const old = turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-a" });
    expect(() => turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-b" })).toThrow(/already active/);
    expect(turns.finish(old)).toBe(true);
    const current = turns.begin({ botId: "bot-a", threadId: "thread-a", generation: "generation-b" });
    expect(turns.bindRuntime("", current)).toBe(false);
    expect(turns.bindRuntime("runtime-old", old)).toBe(false);
    expect(turns.bindRuntime("runtime-current", current)).toBe(true);
    expect(turns.finishRuntime("runtime-old")).toBeNull();
    expect(turns.finishRuntime("runtime-current")).toBe(current);
  });
});
