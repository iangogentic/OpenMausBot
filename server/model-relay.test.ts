import { EventEmitter } from "node:events";

import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { InternalCapabilityBinding } from "./internal-capabilities.ts";
import {
  MODEL_RELAY_COMPUTER_OPERATOR_TURN_REQUEST_BYTES,
  MODEL_RELAY_COMPUTER_PARENT_TURN_REQUEST_BYTES,
  MODEL_RELAY_MAX_REQUEST_BYTES,
  MODEL_RELAY_REQUEST_LIMIT,
  MODEL_RELAY_ROUTE,
  MODEL_RELAY_TURN_REQUEST_BYTES,
  ModelRelayError,
  ModelRelayFrameGuard,
  createModelRelayAuthority,
  fetchModelRelay,
  modelRelayAuthorization,
  modelRelayConnection,
  normalizedModelRelayCapabilityPath,
  validateModelRelayRequest,
  writeModelRelayResponse,
} from "./model-relay.ts";

it("gives visual parent and child turns larger but still bounded aggregate request budgets", () => {
  expect(MODEL_RELAY_COMPUTER_OPERATOR_TURN_REQUEST_BYTES).toBeGreaterThan(MODEL_RELAY_TURN_REQUEST_BYTES);
  expect(MODEL_RELAY_COMPUTER_PARENT_TURN_REQUEST_BYTES).toBeGreaterThan(MODEL_RELAY_TURN_REQUEST_BYTES);
  expect(MODEL_RELAY_COMPUTER_PARENT_TURN_REQUEST_BYTES).toBeLessThan(MODEL_RELAY_COMPUTER_OPERATOR_TURN_REQUEST_BYTES);
  expect(MODEL_RELAY_COMPUTER_OPERATOR_TURN_REQUEST_BYTES)
    .toBeLessThanOrEqual(MODEL_RELAY_REQUEST_LIMIT * MODEL_RELAY_MAX_REQUEST_BYTES);
});

function binding(overrides: Partial<InternalCapabilityBinding> = {}): InternalCapabilityBinding {
  return Object.freeze({
    kind: "model",
    botId: "bot-a",
    threadId: "thread-a",
    depth: 0,
    generation: "generation-a",
    token: "opaque-model-capability-token-a",
    createdAtMs: 1,
    expiresAtMs: 2,
    ...overrides,
  });
}

function authority(overrides: Partial<Parameters<typeof createModelRelayAuthority>[0]> = {}) {
  return createModelRelayAuthority({
    binding: binding(),
    hostId: "desktop2_qwen",
    model: "Qwen3.8-27B-Abliterated",
    upstreamBaseUrl: "http://127.0.0.1:18011/v1",
    upstreamApiKey: "real-upstream-secret",
    ...overrides,
  });
}

class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  destroyed = false;
  writableEnded = false;
  backpressureOnce = false;
  autoDrain = true;

  writeHead(status: number, headers: Record<string, string>) {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: Buffer) {
    this.chunks.push(Buffer.from(chunk));
    if (this.backpressureOnce) {
      this.backpressureOnce = false;
      if (this.autoDrain) queueMicrotask(() => this.emit("drain"));
      return false;
    }
    return true;
  }

  end(chunk?: Buffer) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
    this.emit("finish");
    return this;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

describe("trusted local model relay", () => {
  it("binds an opaque provider connection without exposing the upstream URL or key", () => {
    const source = authority();
    const connection = modelRelayConnection(source, "http://10.0.2.2:8799");
    expect(connection).toEqual({
      openaiBaseUrl: "http://10.0.2.2:8799/api/internal/model-relay/v1",
      anthropicBaseUrl: "http://10.0.2.2:8799/api/internal/model-relay",
      token: source.capabilityToken,
      host: source.hostId,
      model: source.model,
    });
    expect(JSON.stringify(connection)).not.toContain(source.upstreamBaseUrl);
    expect(JSON.stringify(connection)).not.toContain(source.upstreamApiKey);
  });

  it("allows only the Ian Models API or a private literal upstream", () => {
    expect(authority({
      hostId: "ian_models",
      model: "glm-5.3-flash",
      upstreamBaseUrl: "https://models.zai-brain.com/v1",
    }).upstreamBaseUrl).toBe("https://models.zai-brain.com/v1");
    expect(() => authority({ upstreamBaseUrl: "http://models.internal:18011/v1" })).toThrow(/literal, pinned IP/);
    expect(() => authority({ upstreamBaseUrl: "https://models.zai-brain.com.evil.invalid/v1" })).toThrow(/literal, pinned IP/);
    expect(() => authority({ upstreamBaseUrl: "http://169.254.169.254:80/v1" })).toThrow(/private literal/);
    expect(() => authority({ upstreamBaseUrl: "http://203.0.113.8:18011/v1" })).toThrow(/private literal/);
    expect(() => authority({ binding: binding({ kind: "agents" }) })).toThrow(/model capability/);
  });

  it("normalizes only the fixed relay prefix for capability authorization", () => {
    expect(normalizedModelRelayCapabilityPath(`${MODEL_RELAY_ROUTE}/v1/messages`)).toBe(MODEL_RELAY_ROUTE);
    expect(normalizedModelRelayCapabilityPath("/api/internal/agents")).toBe("/api/internal/agents");
  });

  it("accepts either SDK auth dialect and rejects ambiguous/mismatched credentials", () => {
    expect(modelRelayAuthorization({ authorization: "Bearer same-token" })).toBe("Bearer same-token");
    expect(modelRelayAuthorization({ "x-api-key": "same-token" })).toBe("Bearer same-token");
    expect(modelRelayAuthorization({ authorization: "Bearer same-token", "x-api-key": "same-token" })).toBe("Bearer same-token");
    expect(modelRelayAuthorization({ authorization: "Bearer token-a", "x-api-key": "token-b" })).toBeNull();
    expect(modelRelayAuthorization({
      authorization: ["Bearer token-a", "Bearer token-a"],
    } as unknown as IncomingHttpHeaders)).toBeNull();
    expect(modelRelayAuthorization({ authorization: "Basic token-a" })).toBeNull();
  });

  it("allows only reviewed endpoints and the exact bound model", () => {
    const source = authority();
    const body = Buffer.from(JSON.stringify({ model: source.model, messages: [] }));
    expect(validateModelRelayRequest({
      authority: source,
      method: "POST",
      path: `${MODEL_RELAY_ROUTE}/v1/chat/completions`,
      body,
    })).toEqual({ upstreamUrl: "http://127.0.0.1:18011/v1/chat/completions", body });
    expect(() => validateModelRelayRequest({
      authority: source,
      method: "POST",
      path: `${MODEL_RELAY_ROUTE}/v1/chat/completions`,
      body: Buffer.from(JSON.stringify({ model: "another-model" })),
    })).toThrowError(expect.objectContaining({ status: 403 }));
    for (const path of [
      `${MODEL_RELAY_ROUTE}/admin`,
      `${MODEL_RELAY_ROUTE}/v1/models/other`,
      `${MODEL_RELAY_ROUTE}/v1/%2fadmin`,
      `${MODEL_RELAY_ROUTE}/v1/../admin`,
    ]) {
      expect(() => validateModelRelayRequest({ authority: source, method: "POST", path, body })).toThrow(ModelRelayError);
    }
    expect(() => validateModelRelayRequest({
      authority: source,
      method: "GET",
      path: `${MODEL_RELAY_ROUTE}/v1/models`,
      search: "?all=1",
    })).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("replaces provider credentials, strips attacker headers, and disables redirects", async () => {
    const source = authority();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${source.upstreamApiKey}`);
      expect(headers.get("x-api-key")).toBe(source.upstreamApiKey);
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("x-forwarded-for")).toBeNull();
      expect(init?.redirect).toBe("error");
      return new Response("ok", { status: 200 });
    });
    const body = Buffer.from(JSON.stringify({ model: source.model, input: "hi" }));
    await fetchModelRelay({
      authority: source,
      method: "POST",
      path: `${MODEL_RELAY_ROUTE}/v1/responses`,
      headers: {
        authorization: `Bearer ${source.capabilityToken}`,
        "x-api-key": source.capabilityToken,
        cookie: "steal=me",
        "x-forwarded-for": "198.51.100.1",
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: AbortSignal.timeout(1_000),
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:18011/v1/responses", expect.any(Object));
  });

  it("filters /models to the capability's one model and hides upstream error bodies", async () => {
    const source = authority();
    const filtered = new FakeResponse();
    await writeModelRelayResponse({
      authority: source,
      upstream: new Response(JSON.stringify({ object: "list", hiddenModels: ["secret-sibling-model"], data: [
        { id: source.model, object: "model" },
        { id: "secret-sibling-model", object: "model" },
      ] }), { status: 200, headers: { "content-type": "application/json" } }),
      response: filtered as unknown as ServerResponse,
      signal: AbortSignal.timeout(1_000),
      modelList: true,
    });
    expect(filtered.body()).toContain(source.model);
    expect(filtered.body()).not.toContain("secret-sibling-model");

    const failed = new FakeResponse();
    await writeModelRelayResponse({
      authority: source,
      upstream: new Response(`connection failed at ${source.upstreamBaseUrl}?key=${source.upstreamApiKey}`, { status: 500 }),
      response: failed as unknown as ServerResponse,
      signal: AbortSignal.timeout(1_000),
      modelList: false,
    });
    expect(failed.body()).toContain("local model request failed");
    expect(failed.body()).not.toContain(source.upstreamBaseUrl);
    expect(failed.body()).not.toContain(source.upstreamApiKey);
  });

  it("honors backpressure and enforces cumulative byte/frame admissions", async () => {
    const source = authority();
    const response = new FakeResponse();
    response.backpressureOnce = true;
    let byteBudget = 20;
    let frameBudget = 2;
    await writeModelRelayResponse({
      authority: source,
      upstream: new Response("data: a\n\ndata: b\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
      response: response as unknown as ServerResponse,
      signal: AbortSignal.timeout(1_000),
      modelList: false,
      reserveTurnBytes: (amount) => (byteBudget -= amount) >= 0,
      reserveTurnFrames: (amount) => (frameBudget -= amount) >= 0,
    });
    expect(response.body()).toBe("data: a\n\ndata: b\n\n");
    expect(frameBudget).toBe(0);

    const guard = new ModelRelayFrameGuard("ndjson", () => {}, 4);
    expect(() => guard.push(Buffer.from("12345"))).toThrowError(expect.objectContaining({ status: 502 }));
  });

  it("aborts a streaming response when the exact turn signal is revoked", async () => {
    const source = authority();
    const controller = new AbortController();
    controller.abort();
    await expect(writeModelRelayResponse({
      authority: source,
      upstream: new Response("data: still-running\n\n", { headers: { "content-type": "text/event-stream" } }),
      response: new FakeResponse() as unknown as ServerResponse,
      signal: controller.signal,
      modelList: false,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not strand a turn when the downstream closes before a backpressure drain", async () => {
    const response = new FakeResponse();
    response.backpressureOnce = true;
    response.autoDrain = false;
    const pending = writeModelRelayResponse({
      authority: authority(),
      upstream: new Response("data: blocked\n\n", { headers: { "content-type": "text/event-stream" } }),
      response: response as unknown as ServerResponse,
      signal: AbortSignal.timeout(1_000),
      modelList: false,
    });
    setTimeout(() => {
      response.destroyed = true;
      response.emit("close");
    }, 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(response.listenerCount("drain")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });
});
