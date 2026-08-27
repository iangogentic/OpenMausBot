import { describe, expect, it, vi } from "vitest";
import type { ContainerComputerStatus } from "./container-computer.ts";
import { recoverSelectedLocalVm } from "./local-vm-recovery.ts";

function status(overrides: Partial<ContainerComputerStatus> = {}): ContainerComputerStatus {
  return {
    platform: "linux",
    runtime: "docker",
    available: ["docker"],
    daemonUp: true,
    image: true,
    imageMatches: true,
    managed: true,
    container: "running",
    network: "loopback",
    security: "hardened",
    persistence: "durable",
    desktopReady: true,
    desktop_error: null,
    create_supported: true,
    ready: true,
    problem: null,
    image_ref: "image",
    image_id: "image-id",
    base_image_ref: "base",
    driver_version: "0.20.0",
    container_name: "openmausbot-computer",
    target_key: "shared",
    workspace_path: "/workspace",
    workspace_guest_path: "/home/cua/workspace",
    viewer_port: 6080,
    viewer_url: "http://127.0.0.1:6080/vnc.html",
    ...overrides,
  };
}

describe("selected Local VM recovery", () => {
  it("recreates the disposable container after idle cleanup", async () => {
    const running = status({ ready: false, desktopReady: false });
    const ready = status();
    const inspect = vi.fn()
      .mockResolvedValueOnce(status({
        container: "missing",
        managed: false,
        imageMatches: false,
        ready: false,
        desktopReady: false,
      }))
      .mockResolvedValueOnce(ready);
    const act = vi.fn().mockResolvedValue(running);

    expect(await recoverSelectedLocalVm({ inspect, act, sleep: async () => {} })).toEqual(ready);
    expect(act).toHaveBeenCalledWith("run");
  });

  it("removes a managed stopped container before recreating it after a host reboot", async () => {
    const missing = status({ container: "missing", managed: false, ready: false, desktopReady: false });
    const ready = status();
    const act = vi.fn()
      .mockResolvedValueOnce(missing)
      .mockResolvedValueOnce(ready);

    expect(await recoverSelectedLocalVm({
      inspect: async () => status({ container: "stopped", ready: false, desktopReady: false }),
      act,
      sleep: async () => {},
    })).toEqual(ready);
    expect(act.mock.calls.map(([action]) => action)).toEqual(["remove", "run"]);
  });

  it("never deletes a stopped container it does not own", async () => {
    const stopped = status({ container: "stopped", managed: false, ready: false, desktopReady: false });
    const act = vi.fn();
    expect(await recoverSelectedLocalVm({ inspect: async () => stopped, act })).toEqual(stopped);
    expect(act).not.toHaveBeenCalled();
  });
});
