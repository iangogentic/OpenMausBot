import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES,
  canonicalComputerOperatorModel,
  preflightComputerOperatorModel,
} from "./computer-operator-model.ts";
import type { LocalHost } from "./drivers/local-inject.ts";

const host: LocalHost = { id: "desktop2_qwen", label: "desktop2", baseUrl: "http://127.0.0.1:18011/v1" };
const signal = () => new AbortController().signal;

describe("computer operator model preflight", () => {
  it("canonicalizes a mixed-case configured Qwen id before relay launch", () => {
    expect(canonicalComputerOperatorModel("desktop2_qwen", "Qwen3.8-27B-Abliterated"))
      .toBe("desktop2_qwen::qwen3.8-27b-abliterated");
    expect(canonicalComputerOperatorModel("desktop2_qwen", "compatible-alias")).toBeNull();
  });
  it("accepts only the exact model advertised by desktop2", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith("/models")
        ? { data: [{ id: "Qwen3.8-27B-Abliterated" }] }
        : { choices: [{ message: { content: "OK" } }] },
    )));
    await expect(preflightComputerOperatorModel(host, "secret", signal(), fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:18011/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret" }),
    }));
  });

  it("fails closed when the endpoint is dead", async () => {
    await expect(preflightComputerOperatorModel(host, "secret", signal(), async () => {
      throw new Error("connect ECONNREFUSED");
    })).rejects.toThrow("endpoint is unreachable");
  });

  it("fails closed for a live endpoint serving the wrong model", async () => {
    await expect(preflightComputerOperatorModel(host, "secret", signal(), async () =>
      new Response(JSON.stringify({ data: [{ id: "some-compatible-alias" }] })),
    )).rejects.toThrow("is not serving qwen3.8-27b-abliterated");
  });

  it("fails closed when the exact advertised model cannot perform a tiny inference", async () => {
    let calls = 0;
    await expect(preflightComputerOperatorModel(host, "secret", signal(), async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b-abliterated" }] }))
        : new Response("offline", { status: 503 });
    })).rejects.toThrow("inference probe returned HTTP 503");
  });

  it("bounds a dishonest catalog response before parsing", async () => {
    await expect(preflightComputerOperatorModel(host, "secret", signal(), async () =>
      new Response("x".repeat(COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES + 1)),
    )).rejects.toThrow("exceeded its bounded size");
  });

  it("rejects a model match from any other host", async () => {
    await expect(preflightComputerOperatorModel(
      { ...host, id: "compatible_alias" },
      "secret",
      signal(),
      async () => new Response(JSON.stringify({ data: [{ id: "qwen3.8-27b-abliterated" }] })),
    )).rejects.toThrow("host is not trusted");
  });
});
