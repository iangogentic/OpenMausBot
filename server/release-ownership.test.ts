import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

describe("fork release ownership", () => {
  it("pins the normal desktop updater to this fork", () => {
    const builder = source("electron-builder.yml");
    expect(builder).toMatch(/publish:\s*\n\s*- provider: github\s*\n\s*owner: iangogentic\s*\n\s*repo: OpenMausBot/);
    expect(builder).not.toContain("openmausbot-releases");
  });

  it("does not emit an update feed for the distinct Razer controller", () => {
    const remoteBuilder = source("electron-builder.remote.yml");
    expect(remoteBuilder).not.toMatch(/^publish:/m);
  });

  it("cannot publish release artifacts to the upstream maintainer", () => {
    const workflow = source(".github/workflows/release.yml");
    const windowsWorkflow = source(".github/workflows/package-win.yml");
    expect(workflow).not.toContain("milind-soni/");
    expect(workflow).not.toContain("RELEASES_PAT");
    expect(workflow).toContain('--repo "$GITHUB_REPOSITORY"');
    expect(windowsWorkflow).toContain("owner: iangogentic");
    expect(windowsWorkflow).toContain("repo: OpenMausBot");
  });
});
