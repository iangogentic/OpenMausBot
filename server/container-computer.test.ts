import { describe, expect, it, vi } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  BASE_IMAGE,
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CONTAINER,
  CUA_DRIVER_VERSION,
  CUA_EXECUTABLE,
  CUA_SOCKET,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  CONTAINER_NETWORK_LABEL,
  LOCAL_VM_NETWORK_POLICY,
  NETWORK_LAYER_LABEL,
  NETWORK_LAYER_VERSION,
  NETWORK_MANAGED_LABEL,
  NETWORK_TARGET_LABEL,
  SHARED_LOCAL_VM_TARGET,
  TARGET_LABEL,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  VM_WORKSPACE_GUEST_GID,
  VM_WORKSPACE_GUEST_UID,
  WORKSPACE_LABEL,
  applyLinuxDockerWorkspaceAcl,
  computerProxyEnv,
  containerComputerAction,
  containerComputerAgentScreenshot,
  containerComputerMcp,
  containerComputerScreenshot,
  containerComputerStatus,
  currentContainerComputerGeneration,
  containerRuntimeStatus,
  containerRunArgs,
  configuredLocalVmWorkspaceRoot,
  deleteLocalVmWorkspace,
  ensureVmWorkspace,
  ensureLocalVmNetwork,
  localVmNetworkCreateArgs,
  localVmNetworkIdentity,
  localVmNetworkPolicyIsValid,
  linuxDockerWorkspaceCleanupArgs,
  managedImageDockerfile,
  linuxDockerWorkspaceAcl,
  linuxDockerWorkspaceFileAcl,
  perBotLocalVmTarget,
  podmanSecurityIsHardened,
  removeLocalVmNetwork,
  setupCommands,
  type CommandRunner,
  type LocalVmTarget,
} from "./container-computer.ts";

function runner(responses: Record<string, string | Error>) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response instanceof Error || response === undefined) {
      throw response ?? new Error(`unexpected command: ${key}`);
    }
    return { stdout: response };
  };
  return { calls, run };
}

const driverExec =
  `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
  `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CONTAINER} ${CUA_EXECUTABLE}`;
const versionProbe = `${driverExec} --version`;
const statusProbe = `${driverExec} status --socket ${CUA_SOCKET}`;
const healthProbe = `${driverExec} call health_report {} --socket ${CUA_SOCKET}`;
const readinessProbe =
  `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
  "--screenshot-out-file /tmp/openmausbot-readiness.png";
const readinessRead = `docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-readiness.png`;
const validPng = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(600),
  Buffer.from("IEND", "ascii"),
]);
const validJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(600), Buffer.from([0xff, 0xd9])]);

function preparedImageInspect() {
  return JSON.stringify([
    {
      Id: "sha256:managed-image-id",
      Config: {
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
        },
      },
    },
  ]);
}

function readyInspect(overrides: Record<string, unknown> = {}) {
  const network = localVmNetworkIdentity(SHARED_LOCAL_VM_TARGET);
  return JSON.stringify([
    {
      Id: "fixture-container-generation-a",
      Created: "2026-08-29T00:00:00Z",
      Config: {
        Image: IMAGE,
        Labels: {
          [MANAGED_LABEL]: "1",
          [DRIVER_LABEL]: CUA_DRIVER_VERSION,
          [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
          [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
          [WORKSPACE_LABEL]: "1",
          [CONTAINER_NETWORK_LABEL]: network.name,
          [NETWORK_LAYER_LABEL]: NETWORK_LAYER_VERSION,
        },
        Env: ["VNC_PW=secret123"],
      },
      State: { Running: true, StartedAt: "2026-08-29T00:00:01Z" },
      Image: "sha256:managed-image-id",
      // the full hardened HostConfig the stricter shared check now demands:
      // unprivileged, private IPC/cgroup namespaces, pinned shm, no devices
      HostConfig: {
        Memory: 4 * 1024 * 1024 * 1024,
        MemorySwap: 4 * 1024 * 1024 * 1024,
        NanoCpus: 2_000_000_000,
        PidsLimit: 512,
        CapDrop: ["ALL"],
        CapAdd: ["CAP_SETUID", "CAP_SETGID"],
        Privileged: false,
        IpcMode: "private",
        CgroupnsMode: "private",
        ShmSize: 512 * 1024 * 1024,
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        NetworkMode: network.name,
        PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
      },
      Mounts: [
        {
          Type: "bind",
          Source: VM_WORKSPACE_DIR,
          Destination: VM_WORKSPACE_GUEST,
          RW: true,
        },
      ],
      NetworkSettings: {
        Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: "6080" }] },
        Networks: { [network.name]: { NetworkID: "a".repeat(64), IPAddress: "172.30.0.2" } },
      },
      ...overrides,
    },
  ]);
}

function perBotReadyInspect(botId: string, viewerPort: number, targetLabel?: string) {
  const target = perBotLocalVmTarget(botId);
  const detail = JSON.parse(readyInspect())[0];
  detail.Config.Labels[TARGET_LABEL] = targetLabel ?? target.label;
  const network = localVmNetworkIdentity(target);
  detail.Config.Labels[CONTAINER_NETWORK_LABEL] = network.name;
  detail.Mounts[0].Source = target.workspaceDir;
  detail.HostConfig.NetworkMode = network.name;
  detail.HostConfig.PortBindings["6901/tcp"][0].HostPort = String(viewerPort);
  detail.NetworkSettings = {
    Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: String(viewerPort) }] },
    Networks: { [network.name]: { NetworkID: "b".repeat(64), IPAddress: "172.31.0.2" } },
  };
  return JSON.stringify([detail]);
}

function managedNetworkInspect(target: LocalVmTarget, overrides: Record<string, unknown> = {}) {
  const identity = localVmNetworkIdentity(target);
  return JSON.stringify([{
    Name: identity.name,
    Id: "d".repeat(64),
    Driver: "bridge",
    Internal: false,
    Attachable: false,
    Ingress: false,
    EnableIPv6: false,
    Labels: {
      [NETWORK_MANAGED_LABEL]: "1",
      [NETWORK_TARGET_LABEL]: target.label,
      [NETWORK_LAYER_LABEL]: NETWORK_LAYER_VERSION,
    },
    Options: {
      "com.docker.network.bridge.name": identity.bridge,
      "com.docker.network.bridge.enable_icc": "false",
      "com.docker.network.bridge.enable_ip_masquerade": "true",
    },
    Containers: {},
    ...overrides,
  }]);
}

describe("containerComputerStatus", () => {
  it("prefers the supported Podman image store when Docker is also healthy on Windows", async () => {
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": "C:\\Program Files\\Docker\\docker.exe\n",
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      "docker info --format {{.ServerVersion}}": "29.0.0\n",
    });

    const status = await containerRuntimeStatus(fake.run, "win32");

    expect(status).toEqual({
      runtime: "podman",
      available: ["podman", "docker"],
      daemonUp: true,
    });
  });

  it("accepts exact Podman-on-Windows hardening and its WSL-translated durable mount", async () => {
    const derived = perBotLocalVmTarget("bot-win");
    const target: LocalVmTarget = {
      ...derived,
      workspaceDir: "C:\\Users\\light\\.openmausbot\\vm-homes\\win-target",
    };
    const detail = JSON.parse(perBotReadyInspect("bot-win", 41629))[0];
    detail.Mounts[0].Source = "/mnt/c/Users/light/.openmausbot/vm-homes/win-target";
    detail.HostConfig = {
      ...detail.HostConfig,
      CapDrop: ["CAP_CHOWN", "CAP_DAC_OVERRIDE"],
      CapAdd: [],
      PidMode: "private",
      UTSMode: "private",
      CgroupnsMode: null,
    };
    detail.EffectiveCaps = ["CAP_SETGID", "CAP_SETUID"];
    detail.BoundingCaps = ["CAP_SETGID", "CAP_SETUID"];
    const targetDriverExec =
      `podman exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "where.exe podman": "C:\\Program Files\\RedHat\\Podman\\podman.exe\n",
      "where.exe docker": new Error("missing"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${target.containerName}`]: JSON.stringify([detail]),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/openmausbot-readiness.png`]: "{}\n",
      [`podman exec ${target.containerName} base64 -w0 /tmp/openmausbot-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "win32", target);

    expect(status).toMatchObject({
      runtime: "podman",
      security: "hardened",
      persistence: "durable",
      network: "loopback",
      ready: true,
    });
  });

  it("rejects extra effective or bounding capabilities in Podman inspect output", () => {
    const config = {
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: 4 * 1024 * 1024 * 1024,
      NanoCpus: 2_000_000_000,
      PidsLimit: 512,
      CapDrop: ["CAP_CHOWN"],
      CapAdd: [],
      Privileged: false,
      PidMode: "private",
      IpcMode: "private",
      UTSMode: "private",
      ShmSize: 512 * 1024 * 1024,
      Devices: [],
      DeviceRequests: null,
      SecurityOpt: [],
      UsernsMode: "",
      CgroupnsMode: undefined,
      OomKillDisable: false,
      AutoRemove: false,
      RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    };
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(true);
    expect(podmanSecurityIsHardened(
      config,
      ["CAP_NET_RAW", "CAP_SETGID", "CAP_SETUID"],
      ["CAP_SETGID", "CAP_SETUID"],
    )).toBe(false);
  });

  it("keeps per-bot identities, workspaces, and ephemeral viewer ports separate", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const targetDriverExec =
      `docker exec -u cua -e HOME=/home/cua -e DISPLAY=:1 -e CUA_DRIVER_INSTALL_CHANNEL=python_package ` +
      `-e CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${target.containerName} ${CUA_EXECUTABLE}`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152),
      [`${targetDriverExec} --version`]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [`${targetDriverExec} status --socket ${CUA_SOCKET}`]: "running\n",
      [`${targetDriverExec} call health_report {} --socket ${CUA_SOCKET}`]: JSON.stringify({
        schema_version: "1",
        overall: "ok",
        checks: [],
      }),
      [`${targetDriverExec} call get_desktop_state {} --socket ${CUA_SOCKET} --screenshot-out-file /tmp/openmausbot-readiness.png`]: "{}\n",
      [`docker exec ${target.containerName} base64 -w0 /tmp/openmausbot-readiness.png`]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status).toMatchObject({
      container_name: target.containerName,
      target_key: target.key,
      workspace_path: target.workspaceDir,
      viewer_port: 49152,
      managed: true,
      persistence: "durable",
      ready: true,
    });
    expect(status.viewer_url).toContain("http://127.0.0.1:49152/vnc.html");
  });

  it("refuses a per-bot container carrying another target's label", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const other = perBotLocalVmTarget("bot-b");
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${target.containerName}`]: perBotReadyInspect("bot-a", 49152, other.label),
    });

    const status = await containerComputerStatus(fake.run, "linux", target);

    expect(status.managed).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("not created by OpenMausBot");
  });

  it("prefers a running runtime over an earlier installed but stopped one", async () => {
    const network = localVmNetworkIdentity(SHARED_LOCAL_VM_TARGET);
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": "podman\n",
      "docker info --format {{.ServerVersion}}": new Error("daemon stopped"),
      "podman info --format json": '{"host":{"arch":"amd64"}}\n',
      [`podman image inspect ${IMAGE}`]: preparedImageInspect(),
      [`podman inspect ${CONTAINER}`]: JSON.stringify([
        {
          State: { Running: false },
          HostConfig: {
            NetworkMode: network.name,
            PortBindings: { "6901/tcp": [{ HostIp: "127.0.0.1" }] },
          },
          NetworkSettings: { Networks: { [network.name]: { NetworkID: "c".repeat(64) } } },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.runtime).toBe("podman");
    expect(status.available).toEqual(["docker", "podman"]);
    expect(status.daemonUp).toBe(true);
    expect(status.image).toBe(true);
    expect(status.container).toBe("stopped");
    expect(status.network).toBe("loopback");
  });

  it("uses Apple container's actual system and inspect commands", async () => {
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${CONTAINER}`]: JSON.stringify([
        {
          configuration: {
            image: { reference: IMAGE, descriptor: { digest: "sha256:managed-image-id" } },
            resources: { cpus: 2, memoryInBytes: 4 * 1024 * 1024 * 1024 },
            publishedPorts: [{ hostAddress: "127.0.0.1", containerPort: 6901 }],
            labels: {
              [MANAGED_LABEL]: "1",
              [DRIVER_LABEL]: CUA_DRIVER_VERSION,
              [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
              [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
              [WORKSPACE_LABEL]: "1",
              [CONTAINER_NETWORK_LABEL]: localVmNetworkIdentity(SHARED_LOCAL_VM_TARGET).name,
              [NETWORK_LAYER_LABEL]: NETWORK_LAYER_VERSION,
            },
            mounts: [{ source: VM_WORKSPACE_DIR, destination: VM_WORKSPACE_GUEST, options: [] }],
          },
          status: { state: "running" },
        },
      ]),
    });

    const status = await containerComputerStatus(fake.run, "darwin");

    expect(status.runtime).toBe("container");
    expect(status.container).toBe("running");
    expect(status.network).toBe("loopback");
    expect(fake.calls).not.toContain("container info --format {{.ServerVersion}}");
  });

  it("does not report a running container as ready when its viewer is public", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "27\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        HostConfig: {
          Memory: 4 * 1024 * 1024 * 1024,
          MemorySwap: 4 * 1024 * 1024 * 1024,
          NanoCpus: 2_000_000_000,
          PidsLimit: 512,
          CapDrop: ["ALL"],
          CapAdd: ["CAP_SETUID", "CAP_SETGID"],
          PortBindings: { "6901/tcp": [{ HostIp: "0.0.0.0" }] },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.container).toBe("running");
    expect(status.network).toBe("unsafe");
    expect(status.ready).toBe(false);
  });

  it("does not accept Docker's shared default bridge or a second attached VM network", async () => {
    const exact = JSON.parse(readyInspect())[0];
    for (const detail of [
      { ...exact, HostConfig: { ...exact.HostConfig, NetworkMode: "default" } },
      {
        ...exact,
        NetworkSettings: {
          ...exact.NetworkSettings,
          Networks: {
            ...exact.NetworkSettings.Networks,
            "other-bot-network": { NetworkID: "f".repeat(64) },
          },
        },
      },
    ]) {
      const fake = runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: JSON.stringify([detail]),
      });
      const status = await containerComputerStatus(fake.run, "linux");
      expect(status.network).toBe("unsafe");
      expect(status.vm_generation).toBeNull();
      expect(status.ready).toBe(false);
      expect(status.problem).toContain("private network");
    }
  });

  it("fails closed in required deployment mode unless the nft policy is attested", async () => {
    const previousRequired = process.env.OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION;
    const previousPolicy = process.env.OMB_LOCAL_VM_NETWORK_POLICY;
    process.env.OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION = "1";
    delete process.env.OMB_LOCAL_VM_NETWORK_POLICY;
    try {
      const fake = runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: readyInspect(),
      });
      const status = await containerComputerStatus(fake.run, "linux");
      expect(status.network).toBe("unsafe");
      expect(status.ready).toBe(false);
    } finally {
      if (previousRequired === undefined) delete process.env.OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION;
      else process.env.OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION = previousRequired;
      if (previousPolicy === undefined) delete process.env.OMB_LOCAL_VM_NETWORK_POLICY;
      else process.env.OMB_LOCAL_VM_NETWORK_POLICY = previousPolicy;
    }
  });

  it("rejects a privileged or host-namespaced Local VM even with correct limits", async () => {
    // pins the stricter shared hardening check: resource limits alone are
    // not hardening — privilege and namespace escapes disqualify the VM too
    const base = JSON.parse(readyInspect())[0].HostConfig;
    for (const override of [
      { Privileged: true },
      { IpcMode: "host" },
      { PidMode: "host" },
      { CgroupnsMode: "host" },
      { SecurityOpt: ["seccomp=unconfined"] },
      { DeviceRequests: [{ Driver: "nvidia" }] },
      { RestartPolicy: { Name: "always", MaximumRetryCount: 0 } },
    ]) {
      const fake = runner({
        "/usr/bin/which docker": "docker\n",
        "/usr/bin/which podman": new Error("missing"),
        "docker info --format {{.ServerVersion}}": "29\n",
        [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
        [`docker inspect ${CONTAINER}`]: readyInspect({ HostConfig: { ...base, ...override } }),
      });
      const status = await containerComputerStatus(fake.run, "linux");
      expect(status.security, JSON.stringify(override)).toBe("unsafe");
      expect(status.ready).toBe(false);
    }
  });

  it("rejects missing or unexpected host mounts instead of exposing them to the bot", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Mounts: [
          { Type: "bind", Source: VM_WORKSPACE_DIR, Destination: VM_WORKSPACE_GUEST, RW: true },
          { Type: "bind", Source: "/tmp/unexpected", Destination: "/host", RW: true },
        ],
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.persistence).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("durable workspace");
  });

  it("does not mistake an unrelated container executable for Apple container off macOS", async () => {
    const fake = runner({
      "where.exe docker": new Error("missing"),
      "where.exe podman": new Error("missing"),
    });

    const status = await containerComputerStatus(fake.run, "win32");

    expect(status.runtime).toBeNull();
    expect(fake.calls).not.toContain("where.exe container");
  });

  it("reports ready only after the exact image, limits, network, version and daemon pass", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status).toMatchObject({
      imageMatches: true,
      managed: true,
      network: "loopback",
      security: "hardened",
      persistence: "durable",
      desktopReady: true,
      desktop_error: null,
      ready: true,
      problem: null,
      driver_version: "0.20.0",
    });
    expect(status.viewer_url).toContain("#autoconnect=true&resize=scale&password=secret123");
  });

  it("reports the bounded desktop startup error instead of waiting forever", async () => {
    const errorProbe =
      `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: new Error("driver unavailable"),
      [errorProbe]: "X display :1 did not become ready within 45 seconds\n",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("did not become ready");
    expect(status.problem).toContain("desktop failed to start");
  });

  it("does not report ready when the driver's health contract fails", async () => {
    const errorProbe = `docker exec ${CONTAINER} tail -n 4 /var/log/supervisor/cua-driver.error.log`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "failed", checks: [] }),
      [errorProbe]: "",
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.desktopReady).toBe(false);
    expect(status.desktop_error).toContain("health report is failed");
    expect(fake.calls).not.toContain(readinessProbe);
  });

  it("rejects a lookalike container with a different driver or base-image label", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({
        Config: {
          Image: IMAGE,
          Labels: { [MANAGED_LABEL]: "1", [DRIVER_LABEL]: "0.12.4", [BASE_IMAGE_LABEL]: "wrong" },
        },
      }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
    expect(fake.calls).not.toContain(versionProbe);
  });

  it("rejects a container created from a stale build under the same mutable tag", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ Image: "sha256:previous-build-id" }),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image_id).toBe("managed-image-id");
    expect(status.imageMatches).toBe(false);
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("older desktop or Cua Driver");
  });

  it("does not treat an unlabelled image under the local tag as prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: JSON.stringify([{ Config: { Labels: {} } }]),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    const status = await containerComputerStatus(fake.run, "linux");

    expect(status.image).toBe(false);
    expect(status.problem).toContain("Prepare the Cua desktop image");
  });
});

describe("Cua integration", () => {
  it("hands only scoped cloud authority to the isolated remote adapter", () => {
    expect(computerProxyEnv({
      boxId: "bx_1",
      broker: { url: "http://127.0.0.1:8799/api/internal/box", token: "cap" },
    })).toEqual({
      OGB_BOX_ID: "bx_1",
      OMB_BOX_BROKER_URL: "http://127.0.0.1:8799/api/internal/box",
      OMB_BOX_CAPABILITY_TOKEN: "cap",
    });
  });

  it("hands a Local VM provider only the opaque trusted-broker capability", () => {
    const connection = containerComputerMcp({
      url: "ws://127.0.0.1:8799/api/internal/local-vm-computer/mcp",
      token: "x".repeat(43),
    });
    expect(connection.command).toBe(process.execPath);
    expect(connection.args).toHaveLength(1);
    expect(connection.args.join(" ")).not.toMatch(/docker|podman|openmausbot-computer|cua\.sock/i);
    expect(connection.env).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
      OMB_LOCAL_VM_MCP_URL: "ws://127.0.0.1:8799/api/internal/local-vm-computer/mcp",
      OMB_LOCAL_VM_MCP_CAPABILITY: "x".repeat(43),
    });
  });

  it("revalidates the exact running container generation without a Cua or screenshot probe", async () => {
    const inspect = readyInspect();
    const first = runner({ [`docker inspect ${CONTAINER}`]: inspect });
    const generation = await currentContainerComputerGeneration("docker", SHARED_LOCAL_VM_TARGET, first.run);
    expect(generation).toMatch(/^[a-f0-9]{64}$/);
    expect(first.calls).toEqual([`docker inspect ${CONTAINER}`]);

    const replacement = JSON.parse(inspect);
    replacement[0].Id = "fixture-container-generation-b";
    const second = runner({ [`docker inspect ${CONTAINER}`]: JSON.stringify(replacement) });
    expect(await currentContainerComputerGeneration("docker", SHARED_LOCAL_VM_TARGET, second.run)).not.toBe(generation);
  });

  it("invalidates a turn when its VM is moved to another or additional network", async () => {
    const expected = localVmNetworkIdentity(SHARED_LOCAL_VM_TARGET);
    const original = JSON.parse(readyInspect());
    const baseline = runner({ [`docker inspect ${CONTAINER}`]: JSON.stringify(original) });
    const generation = await currentContainerComputerGeneration("docker", SHARED_LOCAL_VM_TARGET, baseline.run);
    expect(generation).toMatch(/^[a-f0-9]{64}$/);

    const replaced = structuredClone(original);
    replaced[0].NetworkSettings.Networks[expected.name].NetworkID = "e".repeat(64);
    const replacement = runner({ [`docker inspect ${CONTAINER}`]: JSON.stringify(replaced) });
    expect(await currentContainerComputerGeneration("docker", SHARED_LOCAL_VM_TARGET, replacement.run))
      .not.toBe(generation);

    const shared = structuredClone(original);
    shared[0].NetworkSettings.Networks["other-vm-network"] = { NetworkID: "f".repeat(64) };
    const extra = runner({ [`docker inspect ${CONTAINER}`]: JSON.stringify(shared) });
    expect(await currentContainerComputerGeneration("docker", SHARED_LOCAL_VM_TARGET, extra.run)).toBeNull();
  });

  it("builds an exact, checksum-verified Cua Driver 0.20.0 image", () => {
    const dockerfile = managedImageDockerfile();
    expect(BASE_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(dockerfile).toContain(`FROM ${BASE_IMAGE}`);
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl");
    expect(dockerfile).toContain("cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl");
    expect(dockerfile).not.toContain("/tmp/cua-driver.whl");
    expect(dockerfile).toContain("sha256sum -c -");
    expect(dockerfile).toContain(`install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}`);
    expect(dockerfile).toContain(`cua-driver ${CUA_DRIVER_VERSION}`);
    expect(dockerfile).toContain(`serve --socket ${CUA_SOCKET} --permission-mode standard`);
    expect(dockerfile).toContain(`groupmod -g ${VM_WORKSPACE_GUEST_GID} cua`);
    expect(dockerfile).toContain(`usermod -u ${VM_WORKSPACE_GUEST_UID} -g ${VM_WORKSPACE_GUEST_GID} cua`);
    expect(CUA_SOCKET).toContain("/home/cua/.openmausbot/");
    expect(dockerfile).toContain("CUA_DRIVER_RS_TELEMETRY_ENABLED=0");
    expect(dockerfile).toContain("prepare-openmausbot-workspace.sh");
    expect(dockerfile).toContain('if ! chmod 0700 "$workspace"');
    expect(dockerfile).toContain('test -r "$directory" && test -w "$directory" && test -x "$directory"');
    expect(dockerfile).toContain("migrate_profile google-chrome");
    expect(dockerfile).toContain("migrate_profile chromium");
    expect(dockerfile).toContain("SingletonLock");
    expect(dockerfile).toContain(`${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"`);
    expect(dockerfile).toContain("did not become ready within 45 seconds");
    expect(dockerfile).not.toContain("while ! DISPLAY=:1 xset q");
  });

  it("rejects a zero-byte OpenSSL base image before the wheel download needs curl", () => {
    const dockerfile = managedImageDockerfile();
    // both multiarch triplets, both OpenSSL libraries
    expect(dockerfile).toContain('"/lib/$lib_triplet/libssl.so.3"');
    expect(dockerfile).toContain('"/lib/$lib_triplet/libcrypto.so.3"');
    expect(dockerfile).toContain("[ ! -s \"$ssl_lib\" ]");
    expect(dockerfile).toContain("is zero bytes, so curl cannot start");
    // the gate runs in the same RUN as the fetch, ahead of it — a defective
    // layer must be named before curl has any chance to fail confusingly
    const gate = dockerfile.indexOf('[ ! -s "$ssl_lib" ]');
    const fetch = dockerfile.indexOf("curl -fsSL");
    expect(gate).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(gate);
  });

  it("captures the preview through Cua Driver rather than xdotool or VNC", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/openmausbot-preview.png";
    const png = validPng;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: png.toString("base64"),
      [screenshotCall]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-preview.png`]: png.toString("base64"),
    });

    const image = await containerComputerScreenshot(fake.run, "linux");

    expect(image).toBe(`data:image/png;base64,${png.toString("base64")}`);
    expect(fake.calls).toContain(screenshotCall);
    expect(fake.calls.some((call) => /xdotool|scrot|vnc/i.test(call))).toBe(false);
  });

  it("bounds model-facing observations as stripped JPEG before relay", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/openmausbot-preview.png";
    const optimizeCall = `docker exec ${CONTAINER} sh -lc raw=/tmp/openmausbot-preview.png; out=/tmp/openmausbot-agent.jpg; command -v convert >/dev/null 2>&1 || exit 69; convert \"$raw\" -resize \"1024x768>\" -strip -quality 72 \"$out\" || exit 70; bytes=$(wc -c < \"$out\"); if [ \"$bytes\" -gt 400000 ]; then convert \"$raw\" -resize \"800x600>\" -strip -quality 55 \"$out\" || exit 71; fi; test \"$(wc -c < \"$out\")\" -le 400000`;
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
      [screenshotCall]: "{}\n",
      [optimizeCall]: "",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-agent.jpg`]: validJpeg.toString("base64"),
    });

    const image = await containerComputerAgentScreenshot(fake.run, "linux");
    expect(image).toBe(`data:image/jpeg;base64,${validJpeg.toString("base64")}`);
    expect(fake.calls).toContain(optimizeCall);
  });

  it("serializes simultaneous screenshot requests for the same desktop", async () => {
    const screenshotCall =
      `${driverExec} call get_desktop_state {} --socket ${CUA_SOCKET} ` +
      "--screenshot-out-file /tmp/openmausbot-preview.png";
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect(),
      [versionProbe]: `cua-driver ${CUA_DRIVER_VERSION}\n`,
      [statusProbe]: "running\n",
      [healthProbe]: JSON.stringify({ schema_version: "1", overall: "degraded", checks: [] }),
      [readinessProbe]: "{}\n",
      [readinessRead]: validPng.toString("base64"),
      [screenshotCall]: "{}\n",
      [`docker exec ${CONTAINER} base64 -w0 /tmp/openmausbot-preview.png`]: validPng.toString("base64"),
    });
    let concurrentCaptures = 0;
    let maxConcurrentCaptures = 0;
    const delayed: CommandRunner = async (command, args, timeout) => {
      const key = [command, ...args].join(" ");
      if (key === screenshotCall) {
        concurrentCaptures += 1;
        maxConcurrentCaptures = Math.max(maxConcurrentCaptures, concurrentCaptures);
        await new Promise((resolve) => setTimeout(resolve, 10));
        try {
          return await fake.run(command, args, timeout);
        } finally {
          concurrentCaptures -= 1;
        }
      }
      return fake.run(command, args, timeout);
    };

    await Promise.all([
      containerComputerScreenshot(delayed, "linux"),
      containerComputerScreenshot(delayed, "linux"),
    ]);

    expect(maxConcurrentCaptures).toBe(1);
  });
});

describe("containerComputerAction", () => {
  it("fails closed instead of giving Apple container an invalid dynamic-port spec", async () => {
    const target = perBotLocalVmTarget("bot-a");
    const fake = runner({
      "/usr/bin/which docker": new Error("missing"),
      "/usr/bin/which podman": new Error("missing"),
      "/usr/bin/which container": "container\n",
      "container system status": "running\n",
      [`container image inspect ${IMAGE}`]: preparedImageInspect(),
      [`container inspect ${target.containerName}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "darwin", target)).rejects.toThrow(
      "require Docker or Podman",
    );
    expect(fake.calls.some((call) => call.startsWith("container run "))).toBe(false);
  });

  it("does not create a VM before its managed image is prepared", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: new Error("missing image"),
      [`docker inspect ${CONTAINER}`]: new Error("missing container"),
    });

    await expect(containerComputerAction("run", fake.run, "linux")).rejects.toThrow(
      "Prepare the Cua desktop image",
    );
    expect(fake.calls.some((call) => call.startsWith("docker run "))).toBe(false);
  });

  it("never starts a stopped desktop because its stale X lock makes resume unsafe", async () => {
    const fake = runner({
      "/usr/bin/which docker": "docker\n",
      "/usr/bin/which podman": new Error("missing"),
      "docker info --format {{.ServerVersion}}": "29\n",
      [`docker image inspect ${IMAGE}`]: preparedImageInspect(),
      [`docker inspect ${CONTAINER}`]: readyInspect({ State: { Running: false } }),
    });

    await expect(containerComputerAction("start", fake.run, "linux")).rejects.toThrow("cannot safely resume");
    expect(fake.calls).not.toContain(`docker start ${CONTAINER}`);
  });
});

describe("setupCommands", () => {
  it("derives a distinct bounded Linux bridge for every exact Local VM target", () => {
    const a = localVmNetworkIdentity(perBotLocalVmTarget("network-bot-a"));
    const b = localVmNetworkIdentity(perBotLocalVmTarget("network-bot-b"));

    expect(a).toEqual(localVmNetworkIdentity(perBotLocalVmTarget("network-bot-a")));
    expect(a.name).toMatch(/^openmaus-vm-[a-f0-9]{16}$/);
    expect(a.bridge).toMatch(/^ombvm[a-f0-9]{10}$/);
    expect(Buffer.byteLength(a.bridge)).toBe(15);
    expect(a.name).not.toBe(b.name);
    expect(a.bridge).not.toBe(b.bridge);
  });

  it("fails closed when a required Razer firewall policy is absent or stale", () => {
    expect(localVmNetworkPolicyIsValid("linux", "docker", {
      OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
    })).toBe(false);
    expect(localVmNetworkPolicyIsValid("linux", "docker", {
      OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
      OMB_LOCAL_VM_NETWORK_POLICY: "stale-policy",
    })).toBe(false);
    expect(localVmNetworkPolicyIsValid("linux", "docker", {
      OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
      OMB_LOCAL_VM_NETWORK_POLICY: LOCAL_VM_NETWORK_POLICY,
    })).toBe(true);
  });

  it("creates or adopts only an exact empty target-labelled Docker network", async () => {
    const target = perBotLocalVmTarget("network-create");
    const identity = localVmNetworkIdentity(target);
    const exact = managedNetworkInspect(target);
    const existing = runner({ [`docker network inspect ${identity.name}`]: exact });
    await ensureLocalVmNetwork("docker", target, existing.run, "linux", {
      OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
      OMB_LOCAL_VM_NETWORK_POLICY: LOCAL_VM_NETWORK_POLICY,
    });
    expect(existing.calls).toEqual([`docker network inspect ${identity.name}`]);

    const calls: string[] = [];
    let inspections = 0;
    const create: CommandRunner = async (command, args) => {
      const call = [command, ...args].join(" ");
      calls.push(call);
      if (args[0] === "network" && args[1] === "inspect") {
        inspections += 1;
        if (inspections === 1) throw new Error("missing");
        return { stdout: exact };
      }
      if (args[0] === "network" && args[1] === "create") return { stdout: `${identity.name}\n` };
      throw new Error(`unexpected command: ${call}`);
    };
    await ensureLocalVmNetwork("docker", target, create, "linux", {
      OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
      OMB_LOCAL_VM_NETWORK_POLICY: LOCAL_VM_NETWORK_POLICY,
    });
    expect(calls).toEqual([
      `docker network inspect ${identity.name}`,
      ["docker", ...localVmNetworkCreateArgs("docker", target)].join(" "),
      `docker network inspect ${identity.name}`,
    ]);
    expect(calls[1]).toContain(`com.docker.network.bridge.name=${identity.bridge}`);
    expect(calls[1]).toContain("com.docker.network.bridge.enable_icc=false");
    expect(calls[1]).toContain("--ipv6=false");
  });

  it("rejects a lookalike or occupied Docker network without mutating it", async () => {
    const target = perBotLocalVmTarget("network-lookalike");
    const identity = localVmNetworkIdentity(target);
    for (const inspect of [
      managedNetworkInspect(target, { Options: { "com.docker.network.bridge.enable_icc": "true" } }),
      managedNetworkInspect(target, { Containers: { attacker: { Name: "other-vm" } } }),
      managedNetworkInspect(target, { Labels: { [NETWORK_MANAGED_LABEL]: "1" } }),
    ]) {
      const fake = runner({ [`docker network inspect ${identity.name}`]: inspect });
      await expect(ensureLocalVmNetwork("docker", target, fake.run, "linux")).rejects.toThrow(
        "exact empty managed bridge",
      );
      expect(fake.calls).toEqual([`docker network inspect ${identity.name}`]);
    }
  });

  it("grants only the trusted service UID and dedicated high Cua UID durable workspace access", async () => {
    const path = mkdtempSync(join(tmpdir(), "openmaus-vm-acl-"));
    const calls: string[] = [];
    try {
      await applyLinuxDockerWorkspaceAcl(path, 947, async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { stdout: "" };
      });
      expect(statSync(path).mode & 0o777).toBe(0o700);
      expect(calls).toEqual([
        `/usr/bin/setfacl --set ${linuxDockerWorkspaceAcl(947)} -- ${path}`,
      ]);
      const acl = linuxDockerWorkspaceAcl(947);
      expect(acl).toContain("u:947:rwx");
      expect(acl).toContain(`u:${VM_WORKSPACE_GUEST_UID}:rwx`);
      expect(acl).not.toContain("u:1000:rwx");
      expect(acl).toContain("d:u:947:rwx");
      expect(acl).toContain(`d:u:${VM_WORKSPACE_GUEST_UID}:rwx`);
      expect(acl).toContain("o::---");
      expect(acl).toContain("d:o::---");
      expect(linuxDockerWorkspaceFileAcl(947, false)).toBe(
        `u::rw-,u:947:rw-,u:${VM_WORKSPACE_GUEST_UID}:rw-,g::---,m::rw-,o::---`,
      );
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("derives opaque, distinct per-bot container and workspace identities", () => {
    const a = perBotLocalVmTarget("bot-a");
    const b = perBotLocalVmTarget("bot-b");

    expect(a).toEqual(perBotLocalVmTarget("bot-a"));
    expect(a.key).not.toBe(b.key);
    expect(a.containerName).not.toBe(b.containerName);
    expect(a.workspaceDir).not.toBe(b.workspaceDir);
    expect(a.containerName).not.toContain("bot-a");
    expect(a.workspaceDir).not.toContain("bot-a");
  });

  it("erases only the hash-derived durable workspace when its bot is deleted", async () => {
    const target = perBotLocalVmTarget("deleted-bot");
    mkdirSync(target.workspaceDir, { recursive: true });
    writeFileSync(join(target.workspaceDir, "private.txt"), "private browser and project data");
    expect(existsSync(target.workspaceDir)).toBe(true);

    await deleteLocalVmWorkspace(target, null, undefined, "darwin");

    expect(existsSync(target.workspaceDir)).toBe(false);
  });

  it("wires the configured bounded root into both shared and per-bot production targets", () => {
    const root = join(tmpdir(), "openmausbot-bounded-vm-root");
    expect(configuredLocalVmWorkspaceRoot({ OMB_LOCAL_VM_HOME_DIR: root })).toBe(root);
    expect(() => configuredLocalVmWorkspaceRoot({ OMB_LOCAL_VM_HOME_DIR: "relative/vms" })).toThrow(
      "must be an absolute path",
    );

    const moduleUrl = new URL(`./container-computer.ts?workspace-root=${Date.now()}`, import.meta.url).href;
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify({ shared: m.SHARED_LOCAL_VM_TARGET.workspaceDir, bot: m.perBotLocalVmTarget("bounded-bot").workspaceDir }));`,
    ], {
      encoding: "utf8",
      env: { ...process.env, OMB_LOCAL_VM_HOME_DIR: root },
    });
    const paths = JSON.parse(output.trim());
    expect(paths.shared).toBe(join(root, "shared"));
    expect(paths.bot).toMatch(new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-f0-9]{16}$`));
  });

  it("builds a root-only, networkless cleanup for the exact managed workspace", () => {
    const target = perBotLocalVmTarget("hostile-tree");
    const args = linuxDockerWorkspaceCleanupArgs(target, "openmausbot-vm-cleanup-0123456789abcdef");
    expect(args).toContain("none");
    expect(args).toContain("--read-only");
    expect(args).toContain("0:0");
    expect(args).toContain("DAC_OVERRIDE");
    expect(args).toContain("FOWNER");
    expect(args).toContain(`type=bind,source=${target.workspaceDir},target=/workspace`);
    expect(args.slice(-5)).toEqual(["/workspace", "-xdev", "-mindepth", "1", "-delete"]);
    expect(args).not.toContain("--privileged");
  });

  it("provisions the bounded storage leaf before production creates the workspace", async () => {
    const target = perBotLocalVmTarget(`leaf-order-${process.pid}`);
    rmSync(target.workspaceDir, { recursive: true, force: true });
    const ensure = vi.fn(() => {
      expect(existsSync(target.workspaceDir)).toBe(false);
    });
    try {
      await ensureVmWorkspace("darwin", "docker", target, async () => ({ stdout: "" }), { ensure });
      expect(ensure).toHaveBeenCalledWith("vm", target.workspaceDir.split(/[\\/]/).at(-1));
      expect(existsSync(target.workspaceDir)).toBe(true);
    } finally {
      rmSync(target.workspaceDir, { recursive: true, force: true });
    }
  });

  it("retires the bounded leaf only after trusted Docker cleanup and helper reaping", async () => {
    const target = perBotLocalVmTarget(`leaf-retire-${process.pid}`);
    mkdirSync(target.workspaceDir, { recursive: true });
    writeFileSync(join(target.workspaceDir, "guest"), "opaque");
    const order: string[] = [];
    const fake: CommandRunner = async (_command, args) => {
      if (args[0] === "run") {
        order.push("cleanup");
        rmSync(join(target.workspaceDir, "guest"), { force: true });
      } else if (args[0] === "rm") {
        order.push("reap");
      }
      return { stdout: "" };
    };
    const retire = vi.fn(async () => {
      order.push("retire");
      expect(existsSync(join(target.workspaceDir, "guest"))).toBe(false);
    });

    await deleteLocalVmWorkspace(target, "docker", fake, "linux", { retire });

    expect(order).toEqual(["cleanup", "reap", "retire"]);
    expect(existsSync(target.workspaceDir)).toBe(false);
  });

  it.runIf(process.env.OMB_REAL_LOCAL_VM_DOCKER_TEST === "1")(
    "uses production ACL preparation and trusted Docker cleanup on a hostile opaque tree",
    async () => {
      const run = promisify(execFile);
      const command: CommandRunner = async (binary, args, timeout = 30_000) => {
        const { stdout } = await run(binary, args, { timeout, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
        return { stdout };
      };
      const target = perBotLocalVmTarget(`real-hostile-${process.pid}`);
      await ensureVmWorkspace("linux", "docker", target, command);
      try {
        await command("docker", [
          "run", "--rm", "--network", "none", "--user", `${VM_WORKSPACE_GUEST_UID}:${VM_WORKSPACE_GUEST_GID}`,
          "--mount", `type=bind,source=${target.workspaceDir},target=/workspace`,
          "--entrypoint", "/bin/sh", IMAGE, "-c",
          "mkdir /workspace/opaque; printf secret > /workspace/opaque/file; chmod 000 /workspace/opaque/file /workspace/opaque",
        ], 60_000);
        await deleteLocalVmWorkspace(target, "docker", command, "linux");
        expect(existsSync(target.workspaceDir)).toBe(false);
      } finally {
        rmSync(target.workspaceDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  it.runIf(process.env.OMB_RAZER_LOCAL_VM_NETWORK_ACCEPTANCE === "1")(
    "allows public web access but denies host, LAN, Tailscale, and a sibling VM on Razer",
    async () => {
      if (process.platform !== "linux") throw new Error("Razer network acceptance requires Linux");
      const execute = promisify(execFile);
      const command: CommandRunner = async (binary, args, timeout = 30_000) => {
        const { stdout } = await execute(binary, args, {
          timeout,
          encoding: "utf8",
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, LANG: "C.UTF-8" },
        });
        return { stdout };
      };
      const nonce = `${process.pid}-${Date.now()}`;
      const targetA = perBotLocalVmTarget(`razer-network-a-${nonce}`);
      const targetB = perBotLocalVmTarget(`razer-network-b-${nonce}`);
      const networkA = localVmNetworkIdentity(targetA);
      const networkB = localVmNetworkIdentity(targetB);
      const clientName = `omb-net-client-${process.pid}`;
      const siblingName = `omb-net-sibling-${process.pid}`;
      const outsideName = `omb-net-outside-${process.pid}`;
      const hostServer = createServer((_request, response) => response.end("host must be unreachable"));
      hostServer.listen(0, "0.0.0.0");
      await once(hostServer, "listening");
      const address = hostServer.address();
      if (!address || typeof address === "string") throw new Error("could not bind hostile host probe");
      const hostPort = address.port;
      const curl = async (url: string) => command("docker", [
        "exec",
        clientName,
        "/usr/bin/curl",
        "--noproxy",
        "*",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "3",
        "--max-time",
        "6",
        url,
      ], 12_000);
      try {
        await ensureLocalVmNetwork("docker", targetA, command, "linux", {
          OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
          OMB_LOCAL_VM_NETWORK_POLICY: LOCAL_VM_NETWORK_POLICY,
        });
        await ensureLocalVmNetwork("docker", targetB, command, "linux", {
          OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION: "1",
          OMB_LOCAL_VM_NETWORK_POLICY: LOCAL_VM_NETWORK_POLICY,
        });
        const sandboxArgs = [
          "--read-only",
          "--cap-drop", "ALL",
          "--security-opt", "no-new-privileges",
          "--pids-limit", "64",
          "--memory", "128m",
          "--memory-swap", "128m",
          "--cpus", "0.5",
        ];
        await command("docker", [
          "run", "-d", "--name", siblingName, "--network", networkB.name,
          "-p", "127.0.0.1::6901",
          ...sandboxArgs,
          "-e", "PYTHONDONTWRITEBYTECODE=1",
          "--entrypoint", "/opt/venv/bin/python", IMAGE,
          "-m", "http.server", "6901", "--bind", "0.0.0.0",
        ], 60_000);
        await command("docker", [
          "run", "-d", "--name", clientName, "--network", networkA.name,
          ...sandboxArgs,
          "--entrypoint", "/bin/sh", IMAGE, "-c", "sleep 180",
        ], 60_000);
        await command("docker", [
          "run", "-d", "--name", outsideName,
          ...sandboxArgs,
          "--entrypoint", "/bin/sh", IMAGE, "-c", "sleep 180",
        ], 60_000);

        const siblingIp = (await command("docker", [
          "inspect", "--format", `{{(index .NetworkSettings.Networks \"${networkB.name}\").IPAddress}}`, siblingName,
        ])).stdout.trim();
        const gateway = (await command("docker", [
          "network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", networkA.name,
        ])).stdout.trim();
        const hostAddresses = (await command("/usr/sbin/ip", ["-4", "-o", "addr", "show", "scope", "global"])).stdout
          .split("\n")
          .map((line) => line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+(?:\.\d+){3})\//))
          .filter((match): match is RegExpMatchArray => Boolean(match));
        const lan = hostAddresses.find((match) =>
          !/^(?:docker|br-|ombvm|tailscale|lo)/.test(match[1]!) &&
          /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(match[2]!),
        )?.[2];
        const tailscale = hostAddresses.find((match) => /^tailscale/.test(match[1]!))?.[2];
        if (!siblingIp || !gateway || !lan || !tailscale) {
          throw new Error("Razer acceptance requires sibling, gateway, LAN, and Tailscale probe addresses");
        }

        await expect(curl("https://example.com/")).resolves.toMatchObject({ stdout: expect.any(String) });
        const published = (await command("docker", ["port", siblingName, "6901/tcp"])).stdout.trim();
        const publishedPort = Number(published.match(/127\.0\.0\.1:(\d+)$/)?.[1]);
        if (!Number.isSafeInteger(publishedPort) || publishedPort < 1 || publishedPort > 65_535) {
          throw new Error("Razer acceptance could not resolve the loopback viewer port");
        }
        await expect(command("/usr/bin/curl", [
          "--noproxy", "*", "--fail", "--silent", "--connect-timeout", "3", "--max-time", "6",
          `http://127.0.0.1:${publishedPort}`,
        ], 12_000)).resolves.toMatchObject({ stdout: expect.any(String) });
        await expect(command("/usr/bin/curl", [
          "--noproxy", "*", "--fail", "--silent", "--connect-timeout", "3", "--max-time", "6",
          `http://${siblingIp}:6901`,
        ], 12_000)).rejects.toBeTruthy();
        await expect(command("docker", [
          "exec", outsideName, "/usr/bin/curl", "--noproxy", "*", "--fail", "--silent",
          "--connect-timeout", "3", "--max-time", "6", `http://${siblingIp}:6901`,
        ], 12_000)).rejects.toBeTruthy();
        for (const [kind, destination] of [
          ["host gateway", gateway],
          ["host LAN", lan],
          ["host Tailscale", tailscale],
          ["sibling VM", siblingIp],
        ] as const) {
          await expect(curl(`http://${destination}:${kind === "sibling VM" ? 6901 : hostPort}`), kind).rejects.toBeTruthy();
        }
      } finally {
        hostServer.close();
        await Promise.race([once(hostServer, "close"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
        await command("docker", ["rm", "-f", clientName], 30_000).catch(() => {});
        await command("docker", ["rm", "-f", siblingName], 30_000).catch(() => {});
        await command("docker", ["rm", "-f", outsideName], 30_000).catch(() => {});
        await removeLocalVmNetwork("docker", targetA, command).catch(() => {});
        await removeLocalVmNetwork("docker", targetB, command).catch(() => {});
      }
    },
    180_000,
  );

  it("asks Docker for an ephemeral loopback viewer port for each per-bot VM", () => {
    const target = perBotLocalVmTarget("bot-a");
    const network = localVmNetworkIdentity(target);
    const args = containerRunArgs("docker", "secret", target);
    const command = ["docker", ...args].join(" ");

    expect(command).toContain(`--name ${target.containerName}`);
    expect(command).toContain(`--label ${TARGET_LABEL}=${target.label}`);
    expect(command).toContain(`--label ${CONTAINER_NETWORK_LABEL}=${network.name}`);
    expect(command).toContain(`--network ${network.name}`);
    expect(command).not.toContain("--network bridge");
    expect(command).toContain(`source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`);
    expect(command).toContain("-p 127.0.0.1::6901");
    expect(command).not.toContain("127.0.0.1:6080:6901");
  });

  it("does not invent Docker commands when no runtime was detected", () => {
    const commands = setupCommands(null, "darwin");
    expect(commands.pull).toBeNull();
    expect(commands.run).toBeNull();
    expect(commands.start).toBeNull();
    expect(commands.install).toContain("podman");
    expect(commands.install).not.toContain("Docker");
  });

  it("publishes only the password-protected viewer and only on loopback", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain("-p 127.0.0.1:6080:6901");
    expect(command).not.toContain(" -p 6080:6901");
    expect(command).not.toContain("5900");
    expect(command).toContain("VNC_PW=CHANGE_ME");
  });

  it("does not suggest docker start for an image that must be recreated", () => {
    expect(setupCommands("docker", "linux").start).toBeNull();
  });

  it("limits resources and retains only the sandbox supervisor's identity-switch caps", () => {
    const command = setupCommands("docker", "linux").run!;
    expect(command).toContain("--memory 4g --memory-swap 4g");
    expect(command).toContain("--cpus 2 --pids-limit 512");
    expect(command).toContain("--ipc private --cgroupns private");
    expect(command).toContain("--cap-drop ALL --cap-add SETUID --cap-add SETGID");
    expect(command).toContain(`--label ${MANAGED_LABEL}=1`);
    expect(command).toContain(`--label ${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`);
    expect(command).toContain(`--label ${WORKSPACE_LABEL}=1`);
    expect(command).toContain(`--hostname ${CONTAINER}`);
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST}`,
    );
  });

  it("asks rootless Podman to map and privately relabel the durable workspace", () => {
    const command = setupCommands("podman", "linux").run!;
    expect(command).toContain(
      `--mount type=bind,source=${VM_WORKSPACE_DIR},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`,
    );
  });

  it("shows the pinned base pull while creating the managed derivative through the API", () => {
    expect(setupCommands("docker", "linux").pull).toBe(`docker pull ${BASE_IMAGE}`);
    expect(setupCommands("docker", "linux").run).toContain(IMAGE);
  });

  it("uses an explicit local image name so Podman never resolves the managed build on Docker Hub", () => {
    expect(IMAGE).toMatch(/^localhost\/openmausbot\/cua-local-vm:/);
    expect(setupCommands("podman", "darwin").run).toContain(IMAGE);
    expect(setupCommands("podman", "darwin").run).not.toContain("docker.io/openmausbot");
  });

  it("generates Apple container lifecycle commands without Docker-only flags", () => {
    const commands = setupCommands("container", "darwin");
    expect(commands.runtimeStart).toBe("container system start");
    expect(commands.remove).toBe(`container rm --force ${CONTAINER}`);
    expect(commands.run).toContain("--memory 4g --cpus 2 --cap-drop ALL");
    expect(commands.run).not.toContain("--memory-swap");
  });

  it("offers the supported Podman Desktop installer on Windows", () => {
    expect(setupCommands(null, "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
  });
});
