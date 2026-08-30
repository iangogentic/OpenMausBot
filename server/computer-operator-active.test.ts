import { describe, expect, it, vi } from "vitest";

import {
  ComputerOperatorActiveConflictError,
  ComputerOperatorAlreadyUsedError,
  consumeComputerOperatorTurn,
  reserveComputerOperator,
} from "./computer-operator-active.ts";

describe("active computer operator reservation", () => {
  it("rejects a conflict before child start is invoked", () => {
    const active = new Map([["parent", { child: "first" }]]);
    const start = vi.fn(() => ({ child: "orphan" }));
    expect(() => reserveComputerOperator(active, "parent", start)).toThrow(ComputerOperatorActiveConflictError);
    expect(start).not.toHaveBeenCalled();
    expect(active.get("parent")).toEqual({ child: "first" });
  });

  it("publishes a freshly started child atomically", () => {
    const active = new Map<string, { child: string }>();
    const value = reserveComputerOperator(active, "parent", () => ({ child: "first" }));
    expect(active.get("parent")).toBe(value);
  });

  it("allows exactly one sequential delegation for a parent turn", () => {
    const state = { delegated: false };
    consumeComputerOperatorTurn(state);
    expect(state.delegated).toBe(true);
    expect(() => consumeComputerOperatorTurn(state)).toThrow(ComputerOperatorAlreadyUsedError);
  });
});
