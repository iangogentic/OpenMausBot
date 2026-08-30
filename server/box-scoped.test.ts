import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "./config.ts";
import {
  scopedBoxOperation,
  SCOPED_BOX_MAX_COMMAND_CHARS,
  SCOPED_BOX_MAX_PROMPT_CHARS,
} from "./box.ts";

describe("server-owned scoped Box operations", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("uses the server-bound Box id and account key, ignoring caller identity claims", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string>)?.authorization,
      });
      return new Response(JSON.stringify({ box: { id: "box-a", state: "ready" } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const cfg: AppConfig = { box: { token: "real-provider-key" } };
    const result = await scopedBoxOperation(cfg, "box-a", {
      op: "state",
      boxId: "box-b",
      botId: "bot-b",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/boxes\/box-a$/);
    expect(seen[0]!.url).not.toContain("box-b");
    expect(seen[0]!.authorization).toBe("Bearer real-provider-key");
    expect(JSON.stringify(result)).not.toContain("real-provider-key");
  });

  it("has no list operation and cannot read arbitrary guest files", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const cfg: AppConfig = { box: { token: "real-provider-key" } };
    await expect(scopedBoxOperation(cfg, "box-a", { op: "list" })).rejects.toThrow(/unsupported/);
    await expect(scopedBoxOperation(cfg, "box-a", {
      op: "read-file",
      path: "/home/cua/.env",
    })).rejects.toThrow(/outside/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects oversized commands and billable prompts before provider I/O", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const cfg: AppConfig = { box: { token: "real-provider-key" } };
    await expect(scopedBoxOperation(cfg, "box-a", {
      op: "command",
      command: "x".repeat(SCOPED_BOX_MAX_COMMAND_CHARS + 1),
    })).rejects.toMatchObject({ status: 400 });
    await expect(scopedBoxOperation(cfg, "box-a", {
      op: "prompt",
      provider: "codex",
      model: "gpt-test",
      prompt: "x".repeat(SCOPED_BOX_MAX_PROMPT_CHARS + 1),
    })).rejects.toMatchObject({ status: 400 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["state fetch", { op: "state" }],
    ["long command fetch", { op: "command", command: "sleep 60" }],
  ])("aborts an in-flight %s when its turn is revoked", async (_label, request) => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("missing abort signal"));
        if (signal.aborted) return reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;

    const pending = scopedBoxOperation(
      { box: { token: "real-provider-key" } },
      "box-a",
      request,
      { signal: controller.signal },
    );
    controller.abort(new Error("turn authority revoked"));

    await expect(pending).rejects.toThrow("turn authority revoked");
    expect(receivedSignal?.aborted).toBe(true);
  });
});
