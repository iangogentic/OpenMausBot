import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  ensureRemoteCuaCommand,
  isolatedRemoteCommand,
  MAX_REMOTE_COMMAND_LENGTH,
  REMOTE_CUA_EXECUTABLE,
  REMOTE_CDP_HELPER_SOURCE,
  REMOTE_CUA_SOCKET,
  REMOTE_CUA_VERSION,
  remoteComputerBootstrapCommand,
  semanticBrowserCommand,
} from "./remote-computer.ts";

describe("remote Cua computer setup", () => {
  it("installs one exact checksummed 0.20.0 driver and disables telemetry", () => {
    const command = remoteComputerBootstrapCommand("Test Bot");
    expect(REMOTE_CUA_VERSION).toBe("0.20.0");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(command).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(command).toContain("f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961");
    expect(command).toContain("48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77");
    expect(command).toContain(`test "$(${REMOTE_CUA_EXECUTABLE} --version)" = "cua-driver 0.20.0"`);
    expect(command).toContain("sha256sum -c -");
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toContain("uv pip install");
    expect(command).not.toContain("cua-computer-server");
    expect(command).not.toContain("--port 8000");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  it("reattaches the private daemon after resume without opening a port", () => {
    const command = ensureRemoteCuaCommand();
    expect(command).toContain(`status --socket ${REMOTE_CUA_SOCKET}`);
    expect(command).toContain(`serve --socket ${REMOTE_CUA_SOCKET} --permission-mode standard`);
    expect(command).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(command).not.toMatch(/--host|--port/);
  });

  it("encodes semantic browser input instead of interpolating it into shell", () => {
    const command = semanticBrowserCommand("fill", { ref: "b7", text: "don't expand $HOME" });
    expect(command).toContain("openmausbot-cdp.mjs fill");
    expect(command).not.toContain("don't expand");
    expect(command).not.toContain("$HOME");
  });

  it("keeps untrusted bot names inert in the nested tmux shell", () => {
    const name = '$(touch /tmp/pwned) `touch /tmp/also-pwned`';
    const command = remoteComputerBootstrapCommand(name);
    expect(command).not.toContain(name);
    expect(command).not.toContain("$(touch /tmp/pwned)");
    expect(command).not.toContain("`touch /tmp/also-pwned`");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n"], { input: command }).status).toBe(0);
    }
  });

  it("shares one bounded credential-isolated remote command contract", () => {
    expect(MAX_REMOTE_COMMAND_LENGTH).toBe(4_000);
    const command = isolatedRemoteCommand("printf %s \\\"$SECRET\\\"");
    expect(command).toContain('exec env -i HOME="$HOME"');
    expect(command).toContain("/bin/bash -c");
    if (process.platform !== "win32") {
      expect(spawnSync("/bin/bash", ["-n", "-c", command]).status).toBe(0);
    }
  });

  it("bounds remote DevTools HTTP, WebSocket, pending, JSON, and AX-tree work", () => {
    expect(spawnSync(process.execPath, ["--input-type=module", "--check"], { input: REMOTE_CDP_HELPER_SOURCE }).status).toBe(0);
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("HTTP_MAX_BYTES = 1024 * 1024");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("WS_MAX_BYTES = 8 * 1024 * 1024");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("WS_MAX_TOTAL_BYTES = 32 * 1024 * 1024");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("WS_MAX_FRAMES_PER_SECOND = 2000");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("MAX_PENDING = 16");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("MAX_JSON_DEPTH = 32");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("MAX_JSON_NODES = 50000");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("AX_MAX_SCANNED_NODES = 10000");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("totalInteractive");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain("truncated: totalInteractive > elements.length");
    expect(REMOTE_CDP_HELPER_SOURCE).toContain('TextDecoder("utf-8", { fatal: true })');
    expect(REMOTE_CDP_HELPER_SOURCE).toContain('import net from "node:net"');
    expect(REMOTE_CDP_HELPER_SOURCE).not.toContain("new WebSocket");
    expect(REMOTE_CDP_HELPER_SOURCE).not.toContain(".json()");
  });
});
