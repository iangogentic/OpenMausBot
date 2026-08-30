import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("development authentication boundary", () => {
  it("rejects browser-only authenticated mode before launching any child", () => {
    const result = spawnSync(process.execPath, ["scripts/dev.mjs", "--web-only"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/browser proxy cannot safely hold harness authority/i);
  });

  it("never gives Vite or its loopback proxy the UI session bearer", () => {
    const config = readFileSync(path.join(root, "vite.config.ts"), "utf8");
    expect(config).not.toMatch(/OMB_UI_SESSION_TOKEN/);
    expect(config).not.toMatch(/setHeader\([^)]*openmausbot-session/i);

    const launcher = readFileSync(path.join(root, "scripts/dev.mjs"), "utf8");
    expect(launcher).toContain("delete viteEnvironment.OMB_UI_SESSION_TOKEN");
  });
});
