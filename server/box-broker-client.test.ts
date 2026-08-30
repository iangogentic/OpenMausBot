import { describe, expect, it, vi } from "vitest";

import { callBoxBroker, validBoxBrokerUrl } from "./box-broker-client.ts";

describe("Box scoped broker client", () => {
  it("accepts only the exact loopback broker authority", () => {
    expect(validBoxBrokerUrl("http://127.0.0.1:8799/api/internal/box")?.pathname).toBe("/api/internal/box");
    for (const invalid of [
      "https://127.0.0.1:8799/api/internal/box",
      "http://localhost:8799/api/internal/box",
      "http://127.0.0.1:8799@evil.invalid/api/internal/box",
      "http://127.0.0.1:8799/api/internal/box?next=evil",
      "http://127.0.0.1:8799/api/internal/other",
    ]) expect(validBoxBrokerUrl(invalid)).toBeNull();
  });

  it("sends only the opaque capability and never needs a provider key", async () => {
    const originalFetch = globalThis.fetch;
    const fake = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer opaque-turn-capability");
      expect(JSON.parse(String(init?.body))).toEqual({ op: "state" });
      return new Response(JSON.stringify({ ok: true, body: { box: { state: "ready" } } }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fake;
    try {
      const result = await callBoxBroker({
        url: "http://127.0.0.1:8799/api/internal/box",
        token: "opaque-turn-capability",
      }, "state");
      expect((result.body as any).box.state).toBe("ready");
      expect(fake).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards an exact proxy action proof only for the async action that owns it", async () => {
    const originalFetch = globalThis.fetch;
    let activeAction: string | undefined = "action_generation-secret";
    const seen: Array<string | undefined> = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>)["x-openmausbot-control-action"]);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const connection = {
        url: "http://127.0.0.1:8799/api/internal/box",
        token: "opaque-turn-capability",
        controlActionId: () => activeAction,
      };
      await callBoxBroker(connection, "command", { command: "true" });
      activeAction = undefined;
      await callBoxBroker(connection, "state");
      expect(seen).toEqual(["action_generation-secret", undefined]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects invalid UTF-8 before parsing a broker response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(Uint8Array.from([0xff, 0xfe]), {
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      await expect(callBoxBroker({
        url: "http://127.0.0.1:8799/api/internal/box",
        token: "opaque-turn-capability",
      }, "state")).rejects.toThrow(/valid UTF-8/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
