import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES,
  COMPUTER_OPERATOR_MODEL_PREFLIGHT_TIMEOUT_MS,
  canonicalComputerOperatorModel,
  preflightComputerOperatorModel,
} from "./computer-operator-model.ts";
import type { LocalHost } from "./drivers/local-inject.ts";

const host: LocalHost = { id: "ian_models", label: "Ian Models", baseUrl: "https://models.zai-brain.com/v1" };
const glmHost: LocalHost = host;
const signal = () => new AbortController().signal;

describe("computer operator model preflight", () => {
  it("gives the catalog and inference probe separate load-tolerant deadlines", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    await preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), async (_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Response(JSON.stringify(++calls === 1
        ? { data: [{ id: "qwen-3.8-27b" }] }
        : { model: "qwen-3.8-27b", choices: [{ message: { content: "O" } }] }));
    });
    expect(COMPUTER_OPERATOR_MODEL_PREFLIGHT_TIMEOUT_MS).toBe(30_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((item) => !item.aborted)).toBe(true);
  });

  it("canonicalizes a mixed-case configured Qwen id before relay launch", () => {
    expect(canonicalComputerOperatorModel("ian_models", "QWEN-3.8-27B"))
      .toBe("ian_models::qwen-3.8-27b");
    expect(canonicalComputerOperatorModel("ian_models", "compatible-alias")).toBeNull();
  });
  it("canonicalizes the audited Spark GLM vision route", () => {
    expect(canonicalComputerOperatorModel("ian_models", "GLM-5.3-FLASH"))
      .toBe("ian_models::glm-5.3-flash");
    expect(canonicalComputerOperatorModel("ian_models", "legacy-glm-slug")).toBeNull();
  });
  it("accepts only the exact model advertised by desktop2", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(
      String(input).endsWith("/models")
        ? { data: [{ id: "QWEN-3.8-27B" }] }
        : { model: "qwen-3.8-27b", choices: [{ message: { content: "O" } }] },
    )));
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledWith("https://models.zai-brain.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer secret" }),
    }));
  });

  it("fails closed when the endpoint is dead", async () => {
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), async () => {
      throw new Error("connect ECONNREFUSED");
    })).rejects.toThrow("endpoint is unreachable");
  });

  it("fails closed for a live endpoint serving the wrong model", async () => {
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), async () =>
      new Response(JSON.stringify({ data: [{ id: "some-compatible-alias" }] })),
    )).rejects.toThrow("is not serving qwen-3.8-27b");
  });

  it("fails closed when the exact advertised model cannot perform a tiny inference", async () => {
    let calls = 0;
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), async () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ data: [{ id: "qwen-3.8-27b" }] }))
        : new Response("offline", { status: 503 });
    })).rejects.toThrow("inference probe returned HTTP 503");
  });

  it("rejects inference from an alias or an empty completion", async () => {
    const responses = (completion: unknown) => {
      let calls = 0;
      return async () => new Response(JSON.stringify(++calls === 1
        ? { data: [{ id: "qwen-3.8-27b" }] }
        : completion));
    };
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), responses({
      model: "compatible-alias",
      choices: [{ message: { content: "O" } }],
    }))).rejects.toThrow("wrong model identity");
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), responses({
      model: "qwen-3.8-27b",
      choices: [{ message: { content: "   " } }],
    }))).rejects.toThrow("no completion");
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), responses({
      model: "qwen-3.8-27b",
      choices: [{ message: { content: null, reasoning: "O" } }],
    }))).resolves.toBeUndefined();
  });

  it("bounds a dishonest catalog response before parsing", async () => {
    await expect(preflightComputerOperatorModel(host, "qwen-3.8-27b", "secret", signal(), async () =>
      new Response("x".repeat(COMPUTER_OPERATOR_MODEL_PREFLIGHT_MAX_BYTES + 1)),
    )).rejects.toThrow("exceeded its bounded size");
  });

  it("rejects a model match from any other host", async () => {
    await expect(preflightComputerOperatorModel(
      { ...host, id: "compatible_alias" },
      "qwen-3.8-27b",
      "secret",
      signal(),
      async () => new Response(JSON.stringify({ data: [{ id: "qwen-3.8-27b" }] })),
    )).rejects.toThrow("route is not trusted");
  });

  it("preflights the exact hosted GLM route and rejects unreviewed models", async () => {
    let calls = 0;
    await expect(preflightComputerOperatorModel(
      glmHost,
      "glm-5.3-flash",
      "secret",
      signal(),
      async () => new Response(JSON.stringify(++calls === 1
        ? { data: [{ id: "glm-5.3-flash" }] }
        : { model: "glm-5.3-flash", choices: [{ message: { content: "O" } }] })),
    )).resolves.toBeUndefined();
    await expect(preflightComputerOperatorModel(
      glmHost,
      "unreviewed-model",
      "secret",
      signal(),
      async () => new Response("unused"),
    )).rejects.toThrow("route is not trusted");
  });
});
