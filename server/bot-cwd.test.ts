import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { validateBotCwd } from "./bot-cwd.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateBotCwd", () => {
  it("accepts an existing absolute directory", () => {
    expect(validateBotCwd(dir)).toEqual({ ok: true, cwd: dir });
  });

  it("treats null and empty as clearing the folder", () => {
    expect(validateBotCwd(null)).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("")).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("   ")).toEqual({ ok: true, cwd: null });
  });

  it("expands a leading ~ to the home folder", () => {
    // compare against homedir() itself: a Windows home like C:\Users\RUNNER~1
    // legitimately contains "~", so "no ~ in the output" is not a valid check
    expect(validateBotCwd("~")).toEqual({ ok: true, cwd: resolve(homedir()) });
  });

  it("rejects relative paths, files, and missing folders with a reason", () => {
    expect(validateBotCwd("relative/path")).toEqual({ ok: false, error: expect.stringMatching(/absolute/) });
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect(validateBotCwd(file)).toEqual({ ok: false, error: expect.stringMatching(/not a folder/) });
    expect(validateBotCwd(join(dir, "nope"))).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist/) });
    expect(validateBotCwd(42)).toEqual({ ok: false, error: expect.stringMatching(/path/) });
  });

  it.runIf(process.platform !== "win32")("confines hardened remote deployments to the managed workspace root", () => {
    const root = join(dir, "managed");
    const project = join(root, "project");
    const outside = join(dir, "outside");
    mkdirSync(project, { recursive: true });
    mkdirSync(outside, { recursive: true });
    expect(validateBotCwd(project, { workspacesRoot: root })).toEqual({ ok: true, cwd: realpathSync(project) });
    expect(validateBotCwd(outside, { workspacesRoot: root })).toEqual({
      ok: false,
      error: expect.stringContaining("managed workspace root"),
    });
    const escape = join(root, "escape");
    symlinkSync(outside, escape);
    expect(validateBotCwd(escape, { workspacesRoot: root })).toEqual({
      ok: false,
      error: expect.stringContaining("managed workspace root"),
    });
  });
});
