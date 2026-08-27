import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  GPU_CAT_CHARACTERS,
  gpuCatActionForMotion,
  gpuCatActionForState,
  gpuCatAsset,
  gpuCatForColor,
} from "./gpucats";

describe("GPU Cats avatar mapping", () => {
  it("gives each primary appearance color a distinct canonical character", () => {
    expect(GPU_CAT_CHARACTERS.map((character) => gpuCatForColor(character.color))).toEqual(
      GPU_CAT_CHARACTERS.map((character) => character.id),
    );
  });

  it("maps live agent states to the closest authored animation", () => {
    expect(gpuCatActionForState("idle")).toBe("idle");
    expect(gpuCatActionForState("working")).toBe("typing");
    expect(gpuCatActionForState("searching")).toBe("thinking");
    expect(gpuCatActionForState("excited")).toBe("happy");
    expect(gpuCatActionForState("alerting")).toBe("confused");
    expect(gpuCatActionForState("drowsy")).toBe("sleeping");
    expect(gpuCatActionForState("dragging")).toBe("walking");
    expect(gpuCatActionForState("spawning")).toBe("fly");
  });

  it("uses one-shot app motions without losing the resting state", () => {
    expect(gpuCatActionForMotion("working")).toBe("typing");
    expect(gpuCatActionForMotion("success")).toBe("happy");
    expect(gpuCatActionForMotion("failure")).toBe("confused");
    expect(gpuCatActionForMotion("arrive")).toBe("fly");
    expect(gpuCatActionForMotion("none")).toBeNull();
  });

  it("selects animated WebP or static PNG assets", () => {
    expect(gpuCatAsset("green", "idle", true)).toBe("/gpucats/miso/idle.webp");
    expect(gpuCatAsset("blue", "thinking", false)).toBe("/gpucats/devcat1/thinking.png");
  });

  it("ships every character/action pair declared by the generated manifest", () => {
    const root = resolve("public/gpucats");
    const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
    if (!manifest || !Array.isArray(manifest.actions)) throw new Error("GPU Cats manifest has no actions");
    expect(manifest.frameDurationsMs).toEqual({
      idle: 90,
      sleeping: 140,
      thinking: 90,
      typing: 70,
      happy: 60,
      confused: 70,
      walking: 55,
      fly: 70,
    });
    for (const character of GPU_CAT_CHARACTERS) {
      for (const action of manifest.actions) {
        expect(existsSync(resolve(root, character.id, `${action}.webp`))).toBe(true);
        expect(existsSync(resolve(root, character.id, `${action}.png`))).toBe(true);
      }
    }
  });
});
