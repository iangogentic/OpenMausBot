import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readSelectedConversationId,
  SELECTED_CONVERSATION_KEY,
  writeSelectedConversationId,
} from "./selected-conversation";

const values = new Map<string, string>();
const fakeStorage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  removeItem: vi.fn((key: string) => values.delete(key)),
};

describe("selected conversation persistence", () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
    vi.stubGlobal("window", { localStorage: fakeStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores the last non-empty conversation after a renderer reload", () => {
    writeSelectedConversationId("  hermes  ");
    expect(values.get(SELECTED_CONVERSATION_KEY)).toBe("hermes");
    expect(readSelectedConversationId()).toBe("hermes");
  });

  it("clears a saved selection when no conversation remains", () => {
    values.set(SELECTED_CONVERSATION_KEY, "hermes");
    writeSelectedConversationId("");
    expect(readSelectedConversationId()).toBe("");
  });

  it("fails open when browser storage is unavailable", () => {
    vi.stubGlobal("window", { localStorage: {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
      removeItem: () => { throw new Error("denied"); },
    } });
    expect(readSelectedConversationId()).toBe("");
    expect(() => writeSelectedConversationId("hermes")).not.toThrow();
  });
});
