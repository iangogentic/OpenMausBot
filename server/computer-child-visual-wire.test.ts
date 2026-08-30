import { describe, expect, it } from "vitest";

import { computerChildVisualsForWire } from "./computer-child-visual-wire.ts";

const visual = {
  childId: "child-1",
  lastSeq: 2,
  frame: {
    mime: "image/png" as const,
    data: "c2Vuc2l0aXZlLXBpeGVscw==",
    hash: "a".repeat(64),
    width: 100,
    height: 50,
    seq: 1,
    at: 1,
  },
  cursor: { x: 3, y: 4, seq: 2, at: 2 },
};

describe("delegated visual wire projection", () => {
  it("omits delegated pixels when screens are off while retaining harmless cursor state", () => {
    const [projected] = computerChildVisualsForWire([visual], false);
    expect(projected).toEqual({
      childId: "child-1",
      lastSeq: 2,
      cursor: visual.cursor,
    });
    expect(JSON.stringify(projected)).not.toContain("c2Vuc2l0aXZlLXBpeGVscw==");
  });

  it("preserves the exact visual state when screens are enabled", () => {
    expect(computerChildVisualsForWire([visual], true)).toEqual([visual]);
  });
});
