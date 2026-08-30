import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readSystemdSessionCredential,
  hasPrivateCredentialMode,
  SYSTEMD_CONTROL_SESSION_CREDENTIAL,
  SYSTEMD_HARNESS_SESSION_CREDENTIAL,
  SYSTEMD_SESSION_CREDENTIAL,
  takeHeadlessSessionToken,
  takeHeadlessSessionTokens,
} from "../src/session-token.ts";

const TOKEN = "s".repeat(48);
const directories: string[] = [];
const directory = () => {
  const value = mkdtempSync(join(tmpdir(), "omb-companion-session-"));
  directories.push(value);
  return value;
};

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("headless companion session credential", () => {
  it("accepts systemd's root-owned 0440 credential shape without widening ordinary files", () => {
    expect(hasPrivateCredentialMode({ mode: 0o100440, uid: 0, gid: 0 })).toBe(true);
    expect(hasPrivateCredentialMode({ mode: 0o100440, uid: 501, gid: 20 })).toBe(false);
    expect(hasPrivateCredentialMode({ mode: 0o100444, uid: 0, gid: 0 })).toBe(false);
    expect(hasPrivateCredentialMode({ mode: 0o100660, uid: 0, gid: 0 })).toBe(false);
  });

  it("accepts only the private regular credential systemd mapped into its unit", () => {
    const root = directory();
    const secure = join(root, "session");
    writeFileSync(secure, `${TOKEN}\n`, { mode: 0o600 });
    expect(readSystemdSessionCredential(secure)).toBe(TOKEN);

    const exposed = join(root, "exposed");
    writeFileSync(exposed, TOKEN, { mode: 0o644 });
    expect(readSystemdSessionCredential(exposed)).toBeNull();

    const link = join(root, "link");
    symlinkSync(secure, link);
    expect(readSystemdSessionCredential(link)).toBeNull();
  });

  it("uses only a systemd credential and erases its path from env", () => {
    const root = directory();
    expect(SYSTEMD_SESSION_CREDENTIAL).toBe(SYSTEMD_HARNESS_SESSION_CREDENTIAL);
    const harnessToken = `h-${"h".repeat(46)}`;
    const controlToken = `c-${"c".repeat(46)}`;
    writeFileSync(join(root, SYSTEMD_HARNESS_SESSION_CREDENTIAL), harnessToken, { mode: 0o600 });
    writeFileSync(join(root, SYSTEMD_CONTROL_SESSION_CREDENTIAL), controlToken, { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {
      CREDENTIALS_DIRECTORY: root,
    };

    expect(takeHeadlessSessionTokens(environment)).toEqual({
      harnessSessionToken: harnessToken,
      controlSessionToken: controlToken,
    });
    expect(environment.CREDENTIALS_DIRECTORY).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain(harnessToken);
    expect(JSON.stringify(environment)).not.toContain(controlToken);
    // This models a provider child inherited after the one startup read:
    // neither raw bearer nor private credential-mount path crosses an env.
    const inherited = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
      env: environment,
    }).toString("utf8");
    expect(inherited).not.toContain(harnessToken);
    expect(inherited).not.toContain(controlToken);
    expect(inherited).not.toContain(root);
  });

  it("fails closed for a world-readable systemd credential", () => {
    const root = directory();
    const insecure = join(root, SYSTEMD_HARNESS_SESSION_CREDENTIAL);
    writeFileSync(insecure, TOKEN, { mode: 0o600 });
    chmodSync(insecure, 0o644);
    expect(takeHeadlessSessionToken({ CREDENTIALS_DIRECTORY: root })).toBeNull();
  });

  it("does not substitute the harness credential for a missing control credential", () => {
    const root = directory();
    writeFileSync(join(root, SYSTEMD_HARNESS_SESSION_CREDENTIAL), TOKEN, { mode: 0o600 });
    expect(takeHeadlessSessionTokens({ CREDENTIALS_DIRECTORY: root })).toEqual({
      harnessSessionToken: TOKEN,
      controlSessionToken: null,
    });
  });
});
