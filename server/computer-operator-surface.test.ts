import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES,
  ComputerOperatorRequestError,
  executeComputerOperatorRequest,
  normalizeComputerOperatorResult,
} from "./computer-operator-surface.ts";

const pixel = Buffer.from([0xff, 0xd8, 0x70, 0x78, 0xff, 0xd9]).toString("base64");

describe("computer operator surface", () => {
  it("blocks on the supplied lifecycle callback and returns final text plus screen", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { text: "done", image: { mimeType: "image/jpeg" as const, data: pixel } };
    });
    const pending = executeComputerOperatorRequest({ task: "open settings" }, new AbortController().signal, execute);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledWith("open settings", expect.any(AbortSignal));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual({ text: "done", image: { mimeType: "image/jpeg", data: pixel } });
  });

  it("requires final visual proof for successful results but permits bounded failures without it", () => {
    expect(() => normalizeComputerOperatorResult({ text: "claimed success" })).toThrow(/without final screen proof/);
    expect(normalizeComputerOperatorResult({ text: "provider failed", isError: true })).toEqual({
      text: "provider failed",
      isError: true,
    });
  });

  it("rejects oversized and malformed images", () => {
    expect(() => normalizeComputerOperatorResult({
      text: "done",
      image: { mimeType: "image/jpeg", data: "A".repeat(COMPUTER_OPERATOR_IMAGE_MAX_BASE64_BYTES + 4) },
    })).toThrow(/too large/);
    expect(() => normalizeComputerOperatorResult({
      text: "done",
      image: { mimeType: "image/jpeg", data: "not base64" },
    })).toThrow(/invalid/);
    expect(() => normalizeComputerOperatorResult({
      text: "done",
      image: { mimeType: "image/png", data: pixel },
    })).toThrow(/do not match/);
  });

  it("does not invoke the executor after parent cancellation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("parent stopped"));
    const execute = vi.fn();
    await expect(executeComputerOperatorRequest({ task: "click" }, controller.signal, execute)).rejects.toThrow("parent stopped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies malformed provider requests as HTTP 400 input errors", async () => {
    await expect(executeComputerOperatorRequest({}, new AbortController().signal, vi.fn())).rejects.toMatchObject({
      constructor: ComputerOperatorRequestError,
      status: 400,
    });
  });
});
