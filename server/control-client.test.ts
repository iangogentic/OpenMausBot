import { describe, expect, it, vi } from "vitest";

import { createControlClient } from "./control-client.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("control client fail-closed authority", () => {
  it("blocks when no control authority was configured", async () => {
    const client = createControlClient({ url: "", token: "" });
    expect(client.configured).toBe(false);
    await expect(client.state(true)).resolves.toEqual({ held: true, helpOpen: false, available: false });
    await expect(client.beginAction()).resolves.toEqual({ allowed: false, reason: "unavailable" });
    await expect(client.quarantineActions()).resolves.toBe(false);
  });

  it.each([
    ["network rejection", () => Promise.reject(new Error("offline"))],
    ["HTTP error", () => Promise.resolve(response({ valid: true, held: false, helpOpen: false }, 503))],
    ["missing validity marker", () => Promise.resolve(response({ held: false, helpOpen: false }))],
    ["malformed fields", () => Promise.resolve(response({ valid: true, held: "no", helpOpen: false }))],
  ])("blocks state on %s", async (_name, fetchImpl) => {
    const client = createControlClient({
      url: "http://control.invalid",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.state(true)).resolves.toEqual({ held: true, helpOpen: false, available: false });
  });

  it("accepts only a strictly marked state response", async () => {
    const fetchImpl = vi.fn(async () => response({ valid: true, held: false, helpOpen: true }));
    const client = createControlClient({
      url: "http://control.invalid",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: true, available: true });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://control.invalid",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer secret" }),
      }),
    );
  });

  it("requires a valid action ticket before allowing forwarding", async () => {
    const replies = [
      response({ valid: true, allowed: true, actionId: "action-1" }),
      response({ valid: true, ended: true }),
      response({ valid: true, allowed: true }),
      response({ valid: true, allowed: false, reason: "takeover-pending" }),
      response({ valid: true, allowed: false, reason: "action-active" }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const client = createControlClient({
      url: "http://control.invalid",
      token: "secret",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.beginAction()).resolves.toEqual({ allowed: true, actionId: "action-1" });
    await expect(client.endAction("action-1")).resolves.toBe(true);
    await expect(client.beginAction()).resolves.toEqual({ allowed: false, reason: "unavailable" });
    await expect(client.beginAction()).resolves.toEqual({ allowed: false, reason: "takeover-pending" });
    await expect(client.beginAction()).resolves.toEqual({ allowed: false, reason: "action-active" });

    const calls = fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit]>;
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ op: "begin-action" });
    expect(JSON.parse(String(calls[1]?.[1]?.body))).toEqual({
      op: "end-action",
      actionId: "action-1",
    });
  });

  it("does not accept an unmarked help response", async () => {
    const replies = [response({ requestId: "old-server" }), response({ valid: true, requestId: "request-1" })];
    const client = createControlClient({
      url: "http://control.invalid",
      token: "secret",
      fetchImpl: (async () => replies.shift()!) as typeof fetch,
    });
    await expect(client.requestHelp("stuck")).resolves.toBeNull();
    await expect(client.requestHelp("stuck")).resolves.toBe("request-1");
  });

  it("requires a marked quarantine acknowledgement", async () => {
    const replies = [response({ valid: true, quarantined: 1 }), response({ valid: true, ended: true })];
    const client = createControlClient({
      url: "http://control.invalid",
      token: "secret",
      fetchImpl: (async () => replies.shift()!) as typeof fetch,
    });
    await expect(client.quarantineActions()).resolves.toBe(true);
    await expect(client.quarantineActions()).resolves.toBe(false);
  });
});
