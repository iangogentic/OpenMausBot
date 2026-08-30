// Cua-backed Local VM lifecycle and health checks.
//
// OpenMausBot owns only the sandbox boundary: image preparation, container
// lifecycle, resource limits, loopback viewer, and target-scoped lease in the
// harness. Desktop automation itself is Cua Driver. Agents reach it only
// through the trusted server-owned Local VM broker; this module never
// reimplements clicks, typing, screenshots, accessibility, or window discovery.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { augmentedPath } from "./env-path.ts";
import { DATA_DIR } from "./config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import { ensureStorageLeafSync, retireStorageLeaf } from "./storage-leaf.ts";

const run = promisify(execFile);
const SCREENSHOT_STATUS_TTL_MS = 10_000;

export type CommandRunner = (
  command: string,
  args: string[],
  timeout?: number,
) => Promise<{ stdout: string }>;

export const CUA_DRIVER_VERSION = "0.20.0";
export const BASE_IMAGE_REPOSITORY = "docker.io/trycua/xfce-cua";
// Official multi-architecture Cua XFCE 0.1.0 manifest (amd64 + arm64).
export const BASE_IMAGE_DIGEST = "sha256:274eb636f5cf3fc58f705916ee72b7a701270b3877369d08533a385c5325be9b";
export const BASE_IMAGE = `${BASE_IMAGE_REPOSITORY}@${BASE_IMAGE_DIGEST}`;
// This tag is built locally from the pinned Cua base. The explicit localhost
// registry is required by Podman: it prepends localhost to unqualified build
// tags, then may otherwise resolve the same name to Docker Hub when running it.
// Image and container labels below remain the authoritative compatibility
// check, not the mutable tag.
export const IMAGE_REPOSITORY = "localhost/openmausbot/cua-local-vm";
export const IMAGE_LAYER_VERSION = "5";
export const IMAGE_LAYER_LABEL = "com.openmausbot.image-layer";
export const IMAGE = `${IMAGE_REPOSITORY}:driver-${CUA_DRIVER_VERSION}-v${IMAGE_LAYER_VERSION}`;
export const CONTAINER = "openmausbot-computer";
export const MANAGED_LABEL = "com.openmausbot.local-vm";
export const DRIVER_LABEL = "com.openmausbot.cua-driver";
export const BASE_IMAGE_LABEL = "com.openmausbot.cua-base";
export const WORKSPACE_LABEL = "com.openmausbot.workspace";
export const TARGET_LABEL = "com.openmausbot.local-vm-target";
export const NETWORK_MANAGED_LABEL = "com.openmausbot.local-vm-network";
export const NETWORK_TARGET_LABEL = "com.openmausbot.local-vm-network-target";
export const NETWORK_LAYER_LABEL = "com.openmausbot.local-vm-network-layer";
export const CONTAINER_NETWORK_LABEL = "com.openmausbot.local-vm-network-name";
export const NETWORK_LAYER_VERSION = "1";
export const LOCAL_VM_NETWORK_POLICY = "openmaus-vm-private-v1";
export const LOCAL_VM_GUEST_ACCOUNT = "openmaus-vm-guest";
// The upstream image's UID 1000 aliases Ian's ordinary host account on Razer.
// The pinned derivative moves `cua` to this deployment-reserved, login-disabled
// identity before it can create a bind-mounted file.
export const VM_WORKSPACE_GUEST_UID = 61_000;
export const VM_WORKSPACE_GUEST_GID = 61_000;

/** A deployment can put durable VM homes on a separately bounded filesystem.
 * Reject relative values at process startup; a service-owned environment is
 * the only input, never an HTTP body. */
export function configuredLocalVmWorkspaceRoot(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = environment.OMB_LOCAL_VM_HOME_DIR?.trim();
  if (!raw) return null;
  if (!isAbsolute(raw) || raw.includes("\0")) {
    throw new Error("OMB_LOCAL_VM_HOME_DIR must be an absolute path");
  }
  return resolve(raw);
}

const CONFIGURED_VM_WORKSPACE_ROOT = configuredLocalVmWorkspaceRoot();
export const VM_WORKSPACE_ROOT = CONFIGURED_VM_WORKSPACE_ROOT ?? join(DATA_DIR, "vm-homes");
export const VM_WORKSPACE_DIR = CONFIGURED_VM_WORKSPACE_ROOT
  ? join(VM_WORKSPACE_ROOT, "shared")
  : join(DATA_DIR, "vm-home");
export const VM_WORKSPACE_GUEST = "/home/cua/workspace";
export const DISPLAY = ":1";
export const CUA_SOCKET = "/home/cua/.openmausbot/cua.sock";
export const CUA_EXECUTABLE = "/usr/local/libexec/openmausbot/cua-driver";

const RUNTIMES = ["docker", "podman", "container"] as const;
export type Runtime = (typeof RUNTIMES)[number];
export type LifecycleAction = "pull" | "run" | "start" | "stop" | "remove";

const INTERNAL_VIEWER_PORT = 6901;
const HOST_VIEWER_PORT = 6080;
const MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
const NANO_CPUS = 2_000_000_000;
const PIDS_LIMIT = 512;
const SHM_BYTES = 512 * 1024 * 1024;

export interface LocalVmTarget {
  /** Stable, non-secret identity used for leases and caches. */
  key: string;
  containerName: string;
  workspaceDir: string;
  /** The historical shared target keeps 6080 for compatibility. Per-bot
   * targets let the runtime allocate a distinct ephemeral loopback port. */
  viewerPort: number | null;
  label: string;
}

export const SHARED_LOCAL_VM_TARGET: LocalVmTarget = {
  key: "shared",
  containerName: CONTAINER,
  workspaceDir: VM_WORKSPACE_DIR,
  viewerPort: HOST_VIEWER_PORT,
  label: "shared",
};

/** Derive filesystem/container identities from a digest, never from a bot's
 * display name or caller-controlled path fragment. */
export function perBotLocalVmTarget(botId: string): LocalVmTarget {
  const digest = createHash("sha256").update(botId).digest("hex");
  const short = digest.slice(0, 16);
  return {
    key: `bot:${digest}`,
    containerName: `${CONTAINER}-${short}`,
    workspaceDir: join(VM_WORKSPACE_ROOT, short),
    viewerPort: null,
    label: digest,
  };
}

export interface LocalVmNetworkIdentity {
  name: string;
  bridge: string;
  digest: string;
}

/** Network identities are derived only from the already-scoped target.  In
 * particular, `target.key` is never interpolated into an interface name: a
 * bot key contains a colon and Linux interface names are limited to 15
 * bytes. */
export function localVmNetworkIdentity(target: LocalVmTarget): LocalVmNetworkIdentity {
  const digest = createHash("sha256")
    .update("openmaus-local-vm-network-v1\0")
    .update(target.key)
    .update("\0")
    .update(target.label)
    .digest("hex");
  return {
    name: `openmaus-vm-${digest.slice(0, 16)}`,
    // `ombvm` + ten hex digits is exactly Linux IFNAMSIZ - 1.
    bridge: `ombvm${digest.slice(0, 10)}`,
    digest,
  };
}

/** Erase the durable home for one derived per-bot VM after the caller has
 * proved its container is gone.  The path is hash-derived here rather than
 * accepted from an HTTP body. */
export async function deletePerBotLocalVmWorkspace(botId: string): Promise<void> {
  const target = perBotLocalVmTarget(botId);
  let runtime: Runtime | null = null;
  if (process.platform === "linux") {
    const detected = await containerRuntimeStatus();
    runtime = detected.daemonUp ? detected.runtime : null;
  }
  await deleteLocalVmWorkspace(target, runtime);
}

const LINUX_WHEELS = {
  x86_64: {
    url: "https://files.pythonhosted.org/packages/fa/d7/a43008a328a40c85e7bc706fc20235b9abedc75e28b413817655153157ff/cua_driver-0.20.0-py3-none-manylinux_2_31_x86_64.whl",
    sha256: "f60c35696a37f37ac954935e478ae4754f220856d022036625c9400d72185961",
  },
  aarch64: {
    url: "https://files.pythonhosted.org/packages/94/9d/1c1838b69067e83266c3d2aae02d74eef353a43dc8644884ccf03fe7f933/cua_driver-0.20.0-py3-none-manylinux_2_31_aarch64.whl",
    sha256: "48833bc5e4c60e701fc9eefb57dbac36ec77ef3990f816fbbe85b4e954af2c77",
  },
} as const;

/** Reproducible, multi-architecture derivative of Cua's sandbox desktop.
 * Both Linux wheels are exact-version and SHA-256 verified. Supervisor owns
 * the daemon so it starts, restarts, and stops with the desktop container.
 *
 * The first RUN also rejects a defective base image before anything uses it:
 * some published ARM64 layers of upstream bases have shipped zero-byte
 * OpenSSL libraries, which surfaces later as a baffling "curl: error while
 * loading shared libraries … file too short" that reads as a network fault.
 * The gate names the actual problem at the step that can act on it. */
export function managedImageDockerfile(): string {
  return `FROM ${BASE_IMAGE}
USER root
RUN set -eux; \\
    old_uid="$(id -u cua)"; old_gid="$(id -g cua)"; \\
    test "$old_uid" = "1000"; test "$old_gid" = "1000"; \\
    groupmod -g ${VM_WORKSPACE_GUEST_GID} cua; \\
    usermod -u ${VM_WORKSPACE_GUEST_UID} -g ${VM_WORKSPACE_GUEST_GID} cua; \\
    find / -xdev -uid "$old_uid" -exec chown -h ${VM_WORKSPACE_GUEST_UID} {} +; \\
    find / -xdev -gid "$old_gid" -exec chgrp -h ${VM_WORKSPACE_GUEST_GID} {} +; \\
    install -d -o cua -g cua -m 0700 /home/cua/.openmausbot; \\
    test "$(id -u cua)" = "${VM_WORKSPACE_GUEST_UID}"; \\
    test "$(id -g cua)" = "${VM_WORKSPACE_GUEST_GID}"
RUN set -eux; \\
    arch="$(uname -m)"; \\
    case "$arch" in \\
      x86_64) wheel_url='${LINUX_WHEELS.x86_64.url}'; wheel_sha='${LINUX_WHEELS.x86_64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_x86_64.whl'; lib_triplet='x86_64-linux-gnu' ;; \\
      aarch64|arm64) wheel_url='${LINUX_WHEELS.aarch64.url}'; wheel_sha='${LINUX_WHEELS.aarch64.sha256}'; wheel_path='/tmp/cua_driver-${CUA_DRIVER_VERSION}-py3-none-manylinux_2_31_aarch64.whl'; lib_triplet='aarch64-linux-gnu' ;; \\
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \\
    esac; \\
    for ssl_lib in "/lib/$lib_triplet/libssl.so.3" "/lib/$lib_triplet/libcrypto.so.3"; do \\
      if [ -e "$ssl_lib" ] && [ ! -s "$ssl_lib" ]; then \\
        echo "pinned base image is defective on $arch: $ssl_lib is zero bytes, so curl cannot start — re-pull or replace the base image instead of debugging the wheel download" >&2; \\
        exit 1; \\
      fi; \\
    done; \\
    curl -fsSL "$wheel_url" -o "$wheel_path"; \\
    echo "$wheel_sha  $wheel_path" | sha256sum -c -; \\
    /opt/venv/bin/python -m pip install --no-cache-dir --force-reinstall --no-deps "$wheel_path"; \\
    rm -f "$wheel_path"; \\
    driver_bin="$(find /opt/venv/lib -path '*/cua_driver/bin/cua-driver' -type f -print -quit)"; \\
    test -n "$driver_bin"; \\
    install -D -m 0755 "$driver_bin" ${CUA_EXECUTABLE}; \\
    install -d -o cua -g cua -m 0700 ${VM_WORKSPACE_GUEST}; \\
    test "$(${CUA_EXECUTABLE} --version)" = "cua-driver ${CUA_DRIVER_VERSION}"
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      'set -eu' \\
      'workspace=${VM_WORKSPACE_GUEST}' \\
      'profiles="$workspace/.browser-profiles"' \\
      'mkdir -p "$profiles/google-chrome" "$profiles/chromium" "$HOME/.config"' \\
      'if ! chmod 0700 "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium" 2>/dev/null; then' \\
      '  for directory in "$workspace" "$profiles" "$profiles/google-chrome" "$profiles/chromium"; do' \\
      '    test -r "$directory" && test -w "$directory" && test -x "$directory"' \\
      '  done' \\
      'fi' \\
      'migrate_profile() {' \\
      '  name="$1"' \\
      '  source="$HOME/.config/$name"' \\
      '  target="$profiles/$name"' \\
      '  if [ -d "$source" ] && [ ! -L "$source" ] && [ -z "$(find "$target" -mindepth 1 -print -quit)" ]; then' \\
      '    cp -a "$source"/. "$target"/' \\
      '  fi' \\
      '  rm -rf "$source"' \\
      '  ln -s "$target" "$source"' \\
      '}' \\
      'migrate_profile google-chrome' \\
      'migrate_profile chromium' \\
      'find "$profiles" \\( -name SingletonLock -o -name SingletonSocket -o -name SingletonCookie -o -name .parentlock \\) -delete' \\
      > /usr/local/bin/prepare-openmausbot-workspace.sh \\
    && chmod 0755 /usr/local/bin/prepare-openmausbot-workspace.sh
RUN printf '%s\\n' \\
      '#!/bin/sh' \\
      '/usr/local/bin/prepare-openmausbot-workspace.sh' \\
      'attempt=0' \\
      'until DISPLAY=:1 xset q >/dev/null 2>&1; do' \\
      '  attempt=$((attempt + 1))' \\
      '  if [ "$attempt" -ge 45 ]; then echo "X display :1 did not become ready within 45 seconds" >&2; exit 1; fi' \\
      '  sleep 1' \\
      'done' \\
      'exec env CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0 ${CUA_EXECUTABLE} serve --socket ${CUA_SOCKET} --permission-mode standard' \\
      > /usr/local/bin/start-openmausbot-cua-driver.sh \\
    && chmod 0755 /usr/local/bin/start-openmausbot-cua-driver.sh
RUN printf '%s\\n' \\
      '' \\
      '[program:openmausbot-cua-driver]' \\
      'command=/usr/local/bin/start-openmausbot-cua-driver.sh' \\
      'user=cua' \\
      'environment=HOME="/home/cua",USER="cua",DISPLAY=":1"' \\
      'autorestart=true' \\
      'startsecs=2' \\
      'stdout_logfile=/var/log/supervisor/cua-driver.log' \\
      'stderr_logfile=/var/log/supervisor/cua-driver.error.log' \\
      'priority=30' \\
      >> /etc/supervisor/supervisord.conf
LABEL ${MANAGED_LABEL}="1" \\
      ${DRIVER_LABEL}="${CUA_DRIVER_VERSION}" \\
      ${BASE_IMAGE_LABEL}="${BASE_IMAGE_DIGEST}" \\
      ${IMAGE_LAYER_LABEL}="${IMAGE_LAYER_VERSION}"
`;
}

async function sh(cmd: string, args: string[], timeout = 8000): Promise<{ stdout: string }> {
  const { stdout } = await run(cmd, args, {
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PATH: augmentedPath() },
  });
  return { stdout };
}

async function installed(
  cmd: string,
  runner: CommandRunner,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await runner(platform === "win32" ? "where.exe" : "/usr/bin/which", [cmd], 4000);
    return true;
  } catch {
    return false;
  }
}

export interface ContainerRuntimeStatus {
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
}

/** Inspect only the host runtime. Unlike a full Local VM status check, this
 * never opens a container, calls Cua, or reads a desktop screenshot. */
export async function containerRuntimeStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
): Promise<ContainerRuntimeStatus> {
  // Podman is the supported Windows VM lane and owns the pinned managed image.
  // Docker may also be installed and healthy on the same host, so the generic
  // Docker-first order would silently select an empty, unrelated image store.
  const candidates: Runtime[] = platform === "win32"
    ? ["podman", "docker"]
    : RUNTIMES.filter((runtime) => runtime !== "container" || platform === "darwin");
  const present = await Promise.all(candidates.map((runtime) => installed(runtime, runner, platform)));
  const available = candidates.filter((_, index) => present[index]);
  const healthy = await Promise.all(
    available.map(async (candidate) => {
      try {
        const infoArgs = candidate === "container"
          ? ["system", "status"]
          : candidate === "podman"
            ? ["info", "--format", "json"]
            : ["info", "--format", "{{.ServerVersion}}"];
        await runner(
          candidate,
          infoArgs,
          10_000,
        );
        return true;
      } catch {
        return false;
      }
    }),
  );
  const healthyIndex = healthy.indexOf(true);
  return {
    runtime: healthyIndex >= 0 ? available[healthyIndex] : (available[0] ?? null),
    available,
    daemonUp: healthyIndex >= 0,
  };
}

export interface ContainerComputerStatus {
  platform: NodeJS.Platform;
  runtime: Runtime | null;
  available: Runtime[];
  daemonUp: boolean;
  image: boolean;
  imageMatches: boolean;
  managed: boolean;
  container: "running" | "stopped" | "missing";
  network: "loopback" | "unsafe" | "unknown";
  security: "hardened" | "unsafe" | "unknown";
  persistence: "durable" | "unsafe" | "unknown";
  desktopReady: boolean;
  desktop_error: string | null;
  create_supported: boolean;
  ready: boolean;
  problem: string | null;
  image_ref: string;
  image_id: string | null;
  /** Opaque identity for this exact running container epoch. A replacement
   * with the same managed name gets a different value. */
  vm_generation: string | null;
  base_image_ref: string;
  driver_version: string;
  container_name: string;
  target_key: string;
  workspace_path: string;
  workspace_guest_path: string;
  viewer_port: number | null;
  viewer_url: string;
}

function emptyStatus(platform: NodeJS.Platform, target: LocalVmTarget): ContainerComputerStatus {
  return {
    platform,
    runtime: null,
    available: [],
    daemonUp: false,
    image: false,
    imageMatches: false,
    managed: false,
    container: "missing",
    network: "unknown",
    security: "unknown",
    persistence: "unknown",
    desktopReady: false,
    desktop_error: null,
    create_supported: true,
    ready: false,
    problem: "Install a supported container runtime first",
    image_ref: IMAGE,
    image_id: null,
    vm_generation: null,
    base_image_ref: BASE_IMAGE,
    driver_version: CUA_DRIVER_VERSION,
    container_name: target.containerName,
    target_key: target.key,
    workspace_path: target.workspaceDir,
    workspace_guest_path: VM_WORKSPACE_GUEST,
    viewer_port: target.viewerPort,
    viewer_url: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

function statusProblem(status: ContainerComputerStatus): string | null {
  if (!status.runtime) return "Install a supported container runtime first";
  if (!status.daemonUp) return `Start ${status.runtime} first`;
  if (!status.image) return `Prepare the Cua desktop image with Driver ${CUA_DRIVER_VERSION}`;
  if (status.container === "missing" && !status.create_supported) {
    return "Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port";
  }
  if (status.container === "missing") return "Create the Local VM";
  if (!status.imageMatches) return "The existing Local VM uses an older desktop or Cua Driver; recreate it";
  if (!status.managed) return "The existing container was not created by OpenMausBot; recreate it";
  if (status.network === "unsafe") {
    return "The existing Local VM lacks its exact private network or exposes its viewer publicly; recreate it";
  }
  if (status.security === "unsafe") return "The existing Local VM is missing safety limits; recreate it";
  if (status.persistence === "unsafe") return "The existing Local VM is missing its durable workspace; recreate it";
  if (status.container === "stopped") return "This desktop image cannot safely resume; recreate the Local VM";
  if (!status.vm_generation) return "The Local VM identity could not be verified; recreate it";
  if (status.desktop_error) return `The Local VM desktop failed to start: ${status.desktop_error}`;
  if (!status.desktopReady) return "The Local VM started, but Cua Driver is not ready yet";
  return null;
}

/** Shared with the BYO-VPS backend (vps-computer.ts): both containers are
 * built from the same pinned derivative, so image compatibility is one rule. */
export function imageLabelsMatch(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[MANAGED_LABEL] === "1" &&
    labels?.[DRIVER_LABEL] === CUA_DRIVER_VERSION &&
    labels?.[BASE_IMAGE_LABEL] === BASE_IMAGE_DIGEST &&
    labels?.[IMAGE_LAYER_LABEL] === IMAGE_LAYER_VERSION
  );
}

function containerLabelsMatch(
  labels: Record<string, string> | undefined,
  target: LocalVmTarget,
): boolean {
  const network = localVmNetworkIdentity(target);
  return (
    imageLabelsMatch(labels) &&
    labels?.[WORKSPACE_LABEL] === "1" &&
    labels?.[CONTAINER_NETWORK_LABEL] === network.name &&
    labels?.[NETWORK_LAYER_LABEL] === NETWORK_LAYER_VERSION &&
    (target.key === SHARED_LOCAL_VM_TARGET.key
      ? labels?.[TARGET_LABEL] === undefined || labels?.[TARGET_LABEL] === target.label
      : labels?.[TARGET_LABEL] === target.label)
  );
}

function normalizeImageId(id: string | undefined): string | null {
  return id?.trim().replace(/^sha256:/, "") || null;
}

function inspectedImage(stdout: string): {
  labels: Record<string, string> | undefined;
  id: string | null;
} {
  const parsed = JSON.parse(stdout) as Array<{
    Id?: string;
    id?: string;
    Config?: { Labels?: Record<string, string> };
    config?: { Labels?: Record<string, string>; labels?: Record<string, string> };
    configuration?: { labels?: Record<string, string>; descriptor?: { digest?: string } };
  }>;
  const image = parsed[0];
  return {
    labels:
      image?.Config?.Labels ?? image?.config?.Labels ?? image?.config?.labels ?? image?.configuration?.labels,
    id: normalizeImageId(image?.Id ?? image?.id ?? image?.configuration?.descriptor?.digest),
  };
}

function viewerPassword(env: string[] | Record<string, string> | undefined): string | null {
  if (Array.isArray(env)) {
    return env.find((entry) => entry.startsWith("VNC_PW="))?.slice("VNC_PW=".length) || null;
  }
  return env?.VNC_PW || null;
}

function viewerUrl(password: string | null, port: number | null): string {
  if (!port) return "";
  const base = `http://127.0.0.1:${port}/vnc.html`;
  if (!password) return base;
  const fragment = new URLSearchParams({ autoconnect: "true", resize: "scale", password });
  return `${base}#${fragment.toString()}`;
}

type ContainerNetworkSettings = {
  Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  Networks?: Record<string, { NetworkID?: string; NetworkId?: string; IPAddress?: string }> | null;
};

/** The Razer unit's root-owned nftables preflight attests this named policy.
 * A required production service fails closed if its environment and installed
 * firewall release drift. Development hosts still get a unique bridge and
 * ICC=false, but must opt into the deployment assertion before that is treated
 * as the Razer host/LAN/Tailscale boundary. */
export function localVmNetworkPolicyIsValid(
  platform: NodeJS.Platform,
  runtime: Runtime,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform !== "linux" || runtime !== "docker") return true;
  const configured = environment.OMB_LOCAL_VM_NETWORK_POLICY?.trim() ?? "";
  if (configured && configured !== LOCAL_VM_NETWORK_POLICY) return false;
  return environment.OMB_REQUIRE_LOCAL_VM_NETWORK_ISOLATION !== "1" || configured === LOCAL_VM_NETWORK_POLICY;
}

function attachedNetworkIdentity(
  hostConfig: { NetworkMode?: string } | undefined,
  networkSettings: ContainerNetworkSettings | undefined,
  target: LocalVmTarget,
): string | null {
  const expected = localVmNetworkIdentity(target);
  if (hostConfig?.NetworkMode !== expected.name) return null;
  const attached = networkSettings?.Networks ?? {};
  const names = Object.keys(attached);
  if (names.length !== 1 || names[0] !== expected.name) return null;
  const rawId = attached[expected.name]?.NetworkID ?? attached[expected.name]?.NetworkId;
  const networkId = rawId?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(networkId)) return null;
  return `${expected.name}:${networkId}`;
}

export function dockerNetworkIsIsolated(
  hostConfig: { NetworkMode?: string; PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> } | undefined,
  networkSettings: ContainerNetworkSettings | undefined,
  target: LocalVmTarget,
  platform: NodeJS.Platform,
  runtime: Runtime,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    dockerPortsAreLocal(hostConfig?.PortBindings) &&
    attachedNetworkIdentity(hostConfig, networkSettings, target) &&
    localVmNetworkPolicyIsValid(platform, runtime, environment)
  );
}

function vmGeneration(input: {
  runtime: Runtime;
  target: LocalVmTarget;
  password: string | null;
  viewerPort: number | null;
  containerIdentity?: string | null;
  startedAt?: string | null;
  imageIdentity?: string | null;
  networkIdentity?: string | null;
}): string | null {
  if (!input.password || !input.viewerPort) return null;
  const containerIdentity = input.containerIdentity?.trim() ?? "";
  const startedAt = input.startedAt?.trim() ?? "";
  const imageIdentity = input.imageIdentity?.trim() ?? "";
  const networkIdentity = input.networkIdentity?.trim() ?? "";
  // VNC_PW is generated afresh by the trusted lifecycle path for every
  // container creation. Container id/start time strengthen that epoch when
  // the selected runtime exposes them, while the digest keeps the password
  // out of capability metadata and public status payloads.
  return createHash("sha256")
    .update(JSON.stringify([
      input.runtime,
      input.target.key,
      input.target.containerName,
      input.viewerPort,
      input.password,
      containerIdentity,
      startedAt,
      imageIdentity,
      networkIdentity,
    ]))
    .digest("hex");
}

/** Cheap exact-container identity check for an already-open MCP broker. It
 * intentionally does not run Cua health/screenshot probes: every tool call
 * can afford one bounded inspect, not a 30-second desktop capture. */
export async function currentContainerComputerGeneration(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<string | null> {
  try {
    const { stdout } = await runner(runtime, ["inspect", target.containerName], 8_000);
    if (runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        id?: string;
        identifier?: string;
        createdAt?: string;
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          publishedPorts?: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
        };
        status?: { state?: string; startedAt?: string };
      }>;
      const detail = inspected[0];
      if (detail?.status?.state !== "running" || !containerLabelsMatch(detail.configuration?.labels, target)) {
        return null;
      }
      const image = typeof detail.configuration?.image === "string"
        ? detail.configuration.image
        : detail.configuration?.image?.descriptor?.digest ??
          detail.configuration?.image?.reference ??
          detail.configuration?.imageReference;
      return vmGeneration({
        runtime,
        target,
        password: viewerPassword(detail.configuration?.environment),
        viewerPort: appleViewerPort(detail.configuration?.publishedPorts, target.viewerPort),
        containerIdentity: detail.id ?? detail.identifier,
        startedAt: detail.status?.startedAt ?? detail.createdAt,
        imageIdentity: image,
      });
    }
    const inspected = JSON.parse(stdout) as Array<{
      Id?: string;
      Created?: string;
      Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
      HostConfig?: {
        NetworkMode?: string;
        PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
      };
      NetworkSettings?: ContainerNetworkSettings;
      State?: { Running?: boolean; StartedAt?: string };
      Image?: string;
    }>;
    const detail = inspected[0];
    if (!detail?.State?.Running || !containerLabelsMatch(detail.Config?.Labels, target)) return null;
    const networkIdentity = attachedNetworkIdentity(detail.HostConfig, detail.NetworkSettings, target);
    if (!networkIdentity) return null;
    return vmGeneration({
      runtime,
      target,
      password: viewerPassword(detail.Config?.Env),
      viewerPort: dockerViewerPort(detail.NetworkSettings?.Ports, target.viewerPort),
      containerIdentity: detail.Id,
      startedAt: detail.State?.StartedAt ?? detail.Created,
      imageIdentity: detail.Image ?? detail.Config?.Image,
      networkIdentity,
    });
  } catch {
    return null;
  }
}

/** The one authoritative `exec … cua-driver` argv. Shared with the BYO-VPS
 * backend and both MCP bridge entry points so the identity, env, and
 * telemetry knobs can never drift between the Local VM and a VPS container. */
export function cuaExecArgs(
  args: string[],
  options: { container?: string; interactive?: boolean } = {},
): string[] {
  return [
    "exec",
    ...(options.interactive ? ["-i"] : []),
    "-u",
    "cua",
    "-e",
    "HOME=/home/cua",
    "-e",
    `DISPLAY=${DISPLAY}`,
    "-e",
    "CUA_DRIVER_INSTALL_CHANNEL=python_package",
    "-e",
    "CUA_DRIVER_RS_TELEMETRY_ENABLED=0",
    options.container ?? CONTAINER,
    CUA_EXECUTABLE,
    ...args,
  ];
}

export async function containerComputerStatus(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  const status = emptyStatus(platform, target);
  const runtimeStatus = await containerRuntimeStatus(runner, platform);
  status.available = runtimeStatus.available;
  status.runtime = runtimeStatus.runtime;
  status.daemonUp = runtimeStatus.daemonUp;
  status.create_supported = target.key === SHARED_LOCAL_VM_TARGET.key || status.runtime !== "container";
  if (!status.runtime || !status.daemonUp) {
    status.problem = statusProblem(status);
    return status;
  }

  try {
    const { stdout } = await runner(status.runtime, ["image", "inspect", IMAGE]);
    const image = inspectedImage(stdout);
    status.image = imageLabelsMatch(image.labels);
    status.image_id = image.id;
  } catch {
    // The prepared OpenMausBot derivative has not been built yet.
  }

  try {
    const { stdout } = await runner(status.runtime, ["inspect", target.containerName]);
    if (status.runtime === "container") {
      const inspected = JSON.parse(stdout) as Array<{
        id?: string;
        identifier?: string;
        createdAt?: string;
        configuration?: {
          image?: string | { reference?: string; descriptor?: { digest?: string } };
          imageReference?: string;
          resources?: { cpus?: number; memoryInBytes?: number };
          publishedPorts?: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }>;
          environment?: string[] | Record<string, string>;
          labels?: Record<string, string>;
          mounts?: Array<{ source?: string; destination?: string; options?: string[] }>;
        };
        status?: { state?: string; startedAt?: string };
      }>;
      const detail = inspected[0];
      status.container = detail?.status?.state === "running" ? "running" : "stopped";
      status.network = applePortsAreLocal(detail?.configuration?.publishedPorts) ? "loopback" : "unsafe";
      status.viewer_port = appleViewerPort(detail?.configuration?.publishedPorts, target.viewerPort);
      const appleImage =
        typeof detail?.configuration?.image === "string"
          ? detail.configuration.image
          : detail?.configuration?.image?.reference ?? detail?.configuration?.imageReference;
      const appleImageId =
        typeof detail?.configuration?.image === "object"
          ? normalizeImageId(detail.configuration.image.descriptor?.digest)
          : null;
      status.imageMatches =
        appleImage === IMAGE && status.image_id !== null && appleImageId === status.image_id;
      status.managed = containerLabelsMatch(detail?.configuration?.labels, target);
      status.persistence = appleWorkspaceMountIsSafe(detail?.configuration?.mounts, platform, target.workspaceDir)
        ? "durable"
        : "unsafe";
      const resources = detail?.configuration?.resources;
      status.security =
        (resources?.memoryInBytes ?? 0) >= MEMORY_BYTES && resources?.cpus === 2 ? "hardened" : "unsafe";
      const password = viewerPassword(detail?.configuration?.environment);
      status.viewer_url = viewerUrl(password, status.viewer_port);
      status.vm_generation = vmGeneration({
        runtime: status.runtime,
        target,
        password,
        viewerPort: status.viewer_port,
        containerIdentity: detail?.id ?? detail?.identifier,
        startedAt: detail?.status?.startedAt ?? detail?.createdAt,
        imageIdentity: appleImageId ?? appleImage,
      });
    } else {
      const inspected = JSON.parse(stdout) as Array<{
        Id?: string;
        Created?: string;
        Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
        HostConfig?: DockerHardeningConfig & {
          NetworkMode?: string;
          PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
        };
        NetworkSettings?: ContainerNetworkSettings;
        Mounts?: Array<{
          Type?: string;
          Source?: string;
          Destination?: string;
          RW?: boolean;
        }>;
        EffectiveCaps?: string[];
        BoundingCaps?: string[];
        State?: { Running?: boolean; StartedAt?: string };
        Image?: string;
      }>;
      const detail = inspected[0];
      status.container = detail?.State?.Running ? "running" : "stopped";
      status.network = dockerNetworkIsIsolated(
        detail?.HostConfig,
        detail?.NetworkSettings,
        target,
        platform,
        status.runtime,
      ) ? "loopback" : "unsafe";
      status.viewer_port = dockerViewerPort(detail?.NetworkSettings?.Ports, target.viewerPort);
      status.imageMatches =
        detail?.Config?.Image === IMAGE &&
        imageLabelsMatch(detail?.Config?.Labels) &&
        status.image_id !== null &&
        normalizeImageId(detail?.Image) === status.image_id;
      status.managed = containerLabelsMatch(detail?.Config?.Labels, target);
      status.persistence = dockerWorkspaceMountIsSafe(
        detail?.Mounts,
        platform,
        target.workspaceDir,
        status.runtime,
      ) ? "durable" : "unsafe";
      status.security = (
        status.runtime === "podman"
          ? podmanSecurityIsHardened(detail?.HostConfig, detail?.EffectiveCaps, detail?.BoundingCaps)
          : dockerSecurityIsHardened(detail?.HostConfig)
      ) ? "hardened" : "unsafe";
      const password = viewerPassword(detail?.Config?.Env);
      status.viewer_url = viewerUrl(password, status.viewer_port);
      const networkIdentity = attachedNetworkIdentity(detail?.HostConfig, detail?.NetworkSettings, target);
      status.vm_generation = networkIdentity
        ? vmGeneration({
            runtime: status.runtime,
            target,
            password,
            viewerPort: status.viewer_port,
            containerIdentity: detail?.Id,
            startedAt: detail?.State?.StartedAt ?? detail?.Created,
            imageIdentity: detail?.Image ?? detail?.Config?.Image,
            networkIdentity,
          })
        : null;
    }
  } catch {
    // No container with this name.
  }

  const canProbe =
    status.container === "running" &&
    status.imageMatches &&
    status.managed &&
    status.network === "loopback" &&
    status.security === "hardened" &&
    status.persistence === "durable";
  if (canProbe) {
    try {
      const expected = `cua-driver ${CUA_DRIVER_VERSION}`;
      const version = await runner(status.runtime, cuaExecArgs(["--version"], { container: target.containerName }), 8000);
      if (version.stdout.trim() !== expected) throw new Error(`expected ${expected}`);
      await runner(status.runtime, cuaExecArgs(["status", "--socket", CUA_SOCKET], { container: target.containerName }), 8000);
      const health = await runner(
        status.runtime,
        cuaExecArgs(["call", "health_report", "{}", "--socket", CUA_SOCKET], { container: target.containerName }),
        15_000,
      );
      const report = JSON.parse(health.stdout) as { schema_version?: string; overall?: string; checks?: unknown[] };
      if (
        report.schema_version !== "1" ||
        !Array.isArray(report.checks) ||
        (report.overall !== "ok" && report.overall !== "degraded")
      ) {
        throw new Error(`Cua health report is ${report.overall ?? "invalid"}`);
      }
      const readinessShot = "/tmp/openmausbot-readiness.png";
      await runner(
        status.runtime,
        cuaExecArgs([
          "call",
          "get_desktop_state",
          "{}",
          "--socket",
          CUA_SOCKET,
          "--screenshot-out-file",
          readinessShot,
        ], { container: target.containerName }),
        20_000,
      );
      const captured = await runner(
        status.runtime,
        ["exec", target.containerName, "base64", "-w0", readinessShot],
        20_000,
      );
      if (!wholeScreenshot(Buffer.from(captured.stdout.trim(), "base64")).ok) {
        throw new Error("Cua Driver returned an incomplete readiness screenshot");
      }
      status.desktopReady = true;
    } catch (error) {
      // An empty log means XFCE and the supervisor-owned Cua daemon are
      // probably still starting. A real startup failure should be actionable
      // in the panel instead of looking like an endless readiness wait.
      status.desktop_error = error instanceof Error ? error.message.slice(0, 320) : null;
      try {
        const errorLog = await runner(
          status.runtime,
          ["exec", target.containerName, "tail", "-n", "4", "/var/log/supervisor/cua-driver.error.log"],
          4000,
        );
        status.desktop_error =
          errorLog.stdout.replace(/\s+/g, " ").trim().slice(0, 320) ||
          status.desktop_error;
      } catch {
        // The log may not exist during the first seconds of container boot.
      }
    }
  }

  status.problem = statusProblem(status);
  status.ready = status.problem === null;
  return status;
}

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

function dockerViewerPort(
  bindings: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`]?.find((entry) => loopback(entry.HostIp))?.HostPort;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

function appleViewerPort(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.find(
    (binding) => binding.containerPort === INTERNAL_VIEWER_PORT && loopback(binding.hostAddress),
  )?.hostPort;
  return Number.isInteger(raw) && Number(raw) > 0 && Number(raw) <= 65_535 ? Number(raw) : fallback;
}

function sameWorkspaceSource(
  source: string | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const expected = resolve(expectedWorkspace);
  return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

/** Podman Machine exposes a Windows bind source through its WSL mount path.
 * Accept only the exact drive/path translation; no parent or prefix match. */
function samePodmanWindowsWorkspaceSource(source: string | undefined, expectedWorkspace: string): boolean {
  if (!source) return false;
  const match = expectedWorkspace.match(/^([A-Za-z]):[\\/](.+)$/);
  if (!match) return false;
  const expected = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
  const actual = source.replaceAll("\\", "/");
  return actual.toLowerCase() === expected.toLowerCase();
}

function dockerWorkspaceMountIsSafe(
  mounts:
    | Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>
    | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
  runtime: Runtime = "docker",
): boolean {
  const sourceMatches = sameWorkspaceSource(mounts?.[0]?.Source, platform, expectedWorkspace) ||
    (runtime === "podman" &&
      platform === "win32" &&
      samePodmanWindowsWorkspaceSource(mounts?.[0]?.Source, expectedWorkspace));
  return Boolean(
    mounts?.length === 1 &&
      mounts[0]?.Type === "bind" &&
      sourceMatches &&
      mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
      mounts[0]?.RW !== false,
  );
}

function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  const options = mounts?.[0]?.options ?? [];
  return Boolean(
    mounts?.length === 1 &&
      sameWorkspaceSource(mounts[0]?.source, platform, expectedWorkspace) &&
      mounts[0]?.destination === VM_WORKSPACE_GUEST &&
      !options.some((option) => option === "ro" || option === "readonly"),
  );
}

/** The Docker/Podman HostConfig surface the hardening check reads. */
export interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

/** One hardening contract for both managed containers (Local VM here, the
 * BYO-VPS backend in vps-computer.ts): exact resource limits, no privilege,
 * no host namespaces or devices, no disabled security profiles. The only
 * knob the callers legitimately disagree on is the restart policy — the VPS
 * container must survive a reboot nobody is watching ("unless-stopped"),
 * while the Local VM must NOT auto-resume: its desktop leaves a stale X lock
 * on stop, so a restarted container is a broken one. */
export function dockerSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  options: { restartPolicy?: "no" | "unless-stopped" } = {},
): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  const restartPolicy = config.RestartPolicy?.Name;
  const restartPolicyOk =
    options.restartPolicy === "unless-stopped"
      ? restartPolicy === "unless-stopped"
      : restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no";
  return (
    config.Memory === MEMORY_BYTES &&
    (config.MemorySwap ?? 0) === MEMORY_BYTES &&
    (config.NanoCpus ?? 0) === NANO_CPUS &&
    config.PidsLimit === PIDS_LIMIT &&
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid" &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    config.ShmSize === SHM_BYTES &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.OomKillDisable !== true &&
    config.AutoRemove !== true &&
    restartPolicyOk
  );
}

/** Podman normalizes HostConfig capability and namespace fields when it
 * serializes inspect output. Validate its authoritative effective/bounding
 * sets, then normalize only those known representation differences through
 * the unchanged Docker hardening contract. */
export function podmanSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  effectiveCaps: string[] | undefined,
  boundingCaps: string[] | undefined,
): boolean {
  if (!config) return false;
  const normalizeCaps = (caps: string[] | undefined) => (caps ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const exactCaps = "setgid,setuid";
  if (normalizeCaps(effectiveCaps).join(",") !== exactCaps) return false;
  if (normalizeCaps(boundingCaps).join(",") !== exactCaps) return false;
  return dockerSecurityIsHardened({
    ...config,
    CapDrop: ["all"],
    CapAdd: effectiveCaps,
    PidMode: config.PidMode === "private" ? "" : config.PidMode,
    UTSMode: config.UTSMode === "private" ? "" : config.UTSMode,
    CgroupnsMode: config.CgroupnsMode || "private",
  });
}

type ManagedNetworkInspect = {
  Name?: string;
  name?: string;
  Id?: string;
  ID?: string;
  id?: string;
  Driver?: string;
  driver?: string;
  Internal?: boolean;
  internal?: boolean;
  Attachable?: boolean;
  attachable?: boolean;
  Ingress?: boolean;
  ingress?: boolean;
  EnableIPv6?: boolean;
  ipv6_enabled?: boolean;
  Labels?: Record<string, string>;
  labels?: Record<string, string>;
  Options?: Record<string, string>;
  options?: Record<string, string>;
  Containers?: Record<string, unknown>;
  containers?: Record<string, unknown>;
};

function inspectedManagedNetwork(stdout: string): ManagedNetworkInspect | null {
  const parsed = JSON.parse(stdout) as ManagedNetworkInspect[] | ManagedNetworkInspect;
  return (Array.isArray(parsed) ? parsed[0] : parsed) ?? null;
}

export function managedLocalVmNetworkMatches(
  detail: ManagedNetworkInspect | null | undefined,
  runtime: Runtime,
  target: LocalVmTarget,
  options: { requireEmpty?: boolean } = {},
): boolean {
  if (!detail || runtime === "container") return false;
  const expected = localVmNetworkIdentity(target);
  const name = detail.Name ?? detail.name;
  const id = (detail.Id ?? detail.ID ?? detail.id)?.trim() ?? "";
  const driver = detail.Driver ?? detail.driver;
  const labels = detail.Labels ?? detail.labels ?? {};
  const networkOptions = detail.Options ?? detail.options ?? {};
  const containers = detail.Containers ?? detail.containers ?? {};
  const internal = detail.Internal ?? detail.internal ?? false;
  const attachable = detail.Attachable ?? detail.attachable ?? false;
  const ingress = detail.Ingress ?? detail.ingress ?? false;
  const ipv6 = detail.EnableIPv6 ?? detail.ipv6_enabled ?? false;
  if (
    name !== expected.name ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(id) ||
    driver !== "bridge" ||
    internal !== false ||
    attachable !== false ||
    ingress !== false ||
    ipv6 !== false ||
    labels[NETWORK_MANAGED_LABEL] !== "1" ||
    labels[NETWORK_TARGET_LABEL] !== target.label ||
    labels[NETWORK_LAYER_LABEL] !== NETWORK_LAYER_VERSION
  ) return false;
  if (options.requireEmpty && Object.keys(containers).length !== 0) return false;
  if (runtime === "docker") {
    return (
      networkOptions["com.docker.network.bridge.name"] === expected.bridge &&
      networkOptions["com.docker.network.bridge.enable_icc"] === "false" &&
      networkOptions["com.docker.network.bridge.enable_ip_masquerade"] === "true"
    );
  }
  // Podman runs in a separate machine on the supported macOS/Windows lanes.
  // Its inspect schema does not expose Docker bridge options, but the exact
  // target-labelled network is still one-per-VM and never shared.
  return true;
}

export function localVmNetworkCreateArgs(runtime: Runtime, target: LocalVmTarget): string[] {
  if (runtime === "container") throw new Error("Apple container owns its VM network boundary");
  const identity = localVmNetworkIdentity(target);
  const args = [
    "network",
    "create",
    "--driver",
    "bridge",
    "--label",
    `${NETWORK_MANAGED_LABEL}=1`,
    "--label",
    `${NETWORK_TARGET_LABEL}=${target.label}`,
    "--label",
    `${NETWORK_LAYER_LABEL}=${NETWORK_LAYER_VERSION}`,
    "--ipv6=false",
  ];
  if (runtime === "docker") {
    args.push(
      "--opt",
      `com.docker.network.bridge.name=${identity.bridge}`,
      "--opt",
      "com.docker.network.bridge.enable_icc=false",
      "--opt",
      "com.docker.network.bridge.enable_ip_masquerade=true",
    );
  }
  args.push(identity.name);
  return args;
}

/** Create or reuse only the exact managed network. A same-name, differently
 * configured bridge is not adopted: doing so could silently attach a bot to
 * the default Docker LAN. */
export async function ensureLocalVmNetwork(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (runtime === "container") return;
  if (!localVmNetworkPolicyIsValid(platform, runtime, environment)) {
    throw new Error(`Local VM network policy must be ${LOCAL_VM_NETWORK_POLICY}`);
  }
  const identity = localVmNetworkIdentity(target);
  let stdout: string | null = null;
  try {
    stdout = (await runner(runtime, ["network", "inspect", identity.name], 8_000)).stdout;
  } catch {
    try {
      await runner(runtime, localVmNetworkCreateArgs(runtime, target), 30_000);
    } catch {
      // A concurrent exact-target creator may have won. The authoritative
      // inspect below decides whether that race is safe.
    }
    stdout = (await runner(runtime, ["network", "inspect", identity.name], 8_000)).stdout;
  }
  const detail = inspectedManagedNetwork(stdout);
  if (!managedLocalVmNetworkMatches(detail, runtime, target, { requireEmpty: true })) {
    throw new Error("Local VM network is not the exact empty managed bridge");
  }
}

export async function removeLocalVmNetwork(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<void> {
  if (runtime === "container") return;
  const identity = localVmNetworkIdentity(target);
  let stdout: string;
  try {
    stdout = (await runner(runtime, ["network", "inspect", identity.name], 8_000)).stdout;
  } catch {
    return;
  }
  if (!managedLocalVmNetworkMatches(inspectedManagedNetwork(stdout), runtime, target, { requireEmpty: true })) {
    throw new Error("Refusing to remove a non-empty or unverified Local VM network");
  }
  await runner(runtime, ["network", "rm", identity.name], 30_000);
}

export function containerRunArgs(
  runtime: Runtime,
  password = "CHANGE_ME",
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): string[] {
  if (runtime === "container" && target.key !== SHARED_LOCAL_VM_TARGET.key) {
    throw new Error("Per-bot Local VMs require Docker or Podman because Apple container requires a fixed host port");
  }
  const common = ["run", "-d", "--name", target.containerName];
  const network = localVmNetworkIdentity(target);
  common.push(
    "--label",
    `${MANAGED_LABEL}=1`,
    "--label",
    `${DRIVER_LABEL}=${CUA_DRIVER_VERSION}`,
    "--label",
    `${BASE_IMAGE_LABEL}=${BASE_IMAGE_DIGEST}`,
    "--label",
    `${IMAGE_LAYER_LABEL}=${IMAGE_LAYER_VERSION}`,
    "--label",
    `${WORKSPACE_LABEL}=1`,
    "--label",
    `${TARGET_LABEL}=${target.label}`,
    "--label",
    `${CONTAINER_NETWORK_LABEL}=${network.name}`,
    "--label",
    `${NETWORK_LAYER_LABEL}=${NETWORK_LAYER_VERSION}`,
  );
  if (runtime === "container") {
    // Apple container already places each Linux container in a lightweight VM.
    common.push(
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
    );
  } else {
    common.push(
      "--network",
      network.name,
      "--hostname",
      target.containerName,
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--cpus",
      "2",
      "--pids-limit",
      String(PIDS_LIMIT),
      // Pinned explicitly rather than trusting daemon defaults: the shared
      // hardening check requires private IPC and cgroup namespaces, and a
      // daemon configured with host-mode defaults would otherwise create a
      // container its own acceptance check then rejects.
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--shm-size",
      "512m",
    );
  }
  common.push(
    "--mount",
    runtime === "podman"
      ? `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST},relabel=private,U=true`
      : `type=bind,source=${target.workspaceDir},target=${VM_WORKSPACE_GUEST}`,
    "-e",
    `VNC_PW=${password}`,
    "-p",
    target.viewerPort
      ? `127.0.0.1:${target.viewerPort}:${INTERNAL_VIEWER_PORT}`
      : `127.0.0.1::${INTERNAL_VIEWER_PORT}`,
    IMAGE,
  );
  return common;
}

function managedVmWorkspacePath(path: string): boolean {
  if (!isAbsolute(path)) return false;
  if (CONFIGURED_VM_WORKSPACE_ROOT) {
    const rel = relative(VM_WORKSPACE_ROOT, resolve(path));
    return rel === "shared" || /^[a-f0-9]{16}$/.test(rel);
  }
  const rel = relative(resolve(DATA_DIR), resolve(path));
  return rel === "vm-home" || /^vm-homes[\\/][a-f0-9]{16}$/.test(rel);
}

function workspaceRootForTarget(target: LocalVmTarget): string {
  if (CONFIGURED_VM_WORKSPACE_ROOT) return VM_WORKSPACE_ROOT;
  return target.key === SHARED_LOCAL_VM_TARGET.key ? resolve(DATA_DIR) : VM_WORKSPACE_ROOT;
}

function storageLeafKeyForTarget(target: LocalVmTarget): string {
  if (target.key === SHARED_LOCAL_VM_TARGET.key) return "shared";
  const leaf = relative(workspaceRootForTarget(target), resolve(target.workspaceDir));
  if (!/^[a-f0-9]{16}$/.test(leaf)) throw new Error("invalid Local VM storage leaf identity");
  return leaf;
}

export function linuxDockerWorkspaceAcl(serverUid: number): string {
  if (!Number.isSafeInteger(serverUid) || serverUid < 1) throw new Error("Local VM workspace needs a real server UID");
  if (serverUid === VM_WORKSPACE_GUEST_UID) throw new Error("Local VM server and guest UIDs must be distinct");
  const named = [...new Set([serverUid, VM_WORKSPACE_GUEST_UID])]
    .map((uid) => `u:${uid}:rwx`)
    .join(",");
  const defaults = [...new Set([serverUid, VM_WORKSPACE_GUEST_UID])]
    .map((uid) => `d:u:${uid}:rwx`)
    .join(",");
  return `u::rwx,${named},g::---,m::rwx,o::---,d:u::rwx,${defaults},d:g::---,d:m::rwx,d:o::---`;
}

export function linuxDockerWorkspaceFileAcl(serverUid: number, executable: boolean): string {
  if (!Number.isSafeInteger(serverUid) || serverUid < 1) throw new Error("Local VM workspace needs a real server UID");
  if (serverUid === VM_WORKSPACE_GUEST_UID) throw new Error("Local VM server and guest UIDs must be distinct");
  const permission = executable ? "rwx" : "rw-";
  const named = [...new Set([serverUid, VM_WORKSPACE_GUEST_UID])]
    .map((uid) => `u:${uid}:${permission}`)
    .join(",");
  return `u::${permission},${named},g::---,m::${permission},o::---`;
}

/** Docker bind mounts retain host numeric ownership. Keep the directory
 * server-owned, then grant only the deployment-reserved Cua uid 61000 and the
 * exact server uid access/default ACLs. The ordinary Razer login uid 1000 has
 * no alias to the guest and receives no ACL entry. */
export async function applyLinuxDockerWorkspaceAcl(
  path: string,
  serverUid: number,
  runner: CommandRunner = sh,
): Promise<void> {
  const root = await lstat(path);
  const pending = [path];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    const info = await lstat(current);
    visited += 1;
    if (visited > 100_000) throw new Error("Local VM workspace has too many entries to secure");
    if (info.isSymbolicLink() || info.dev !== root.dev) {
      throw new Error("Local VM workspace contains a link or nested mount");
    }
    if (info.isDirectory()) {
      await chmod(current, 0o700);
      // --set replaces, rather than merges, the complete access/default ACL.
      // This removes every stale named principal left by an earlier mapping.
      await runner("/usr/bin/setfacl", ["--set", linuxDockerWorkspaceAcl(serverUid), "--", current], 8_000);
      for (const child of await readdir(current)) pending.push(join(current, child));
      continue;
    }
    if (!info.isFile()) throw new Error("Local VM workspace contains an unsupported inode");
    const executable = Boolean(info.mode & 0o111);
    await chmod(current, executable ? 0o700 : 0o600);
    await runner(
      "/usr/bin/setfacl",
      ["--set", linuxDockerWorkspaceFileAcl(serverUid, executable), "--", current],
      8_000,
    );
  }
}

function safeDedicatedGuestIdentity(record: string, kind: "passwd" | "group"): boolean {
  const fields = record.trim().split(":");
  if (kind === "group") {
    return fields[0] === LOCAL_VM_GUEST_ACCOUNT && Number(fields[2]) === VM_WORKSPACE_GUEST_GID;
  }
  return (
    fields[0] === LOCAL_VM_GUEST_ACCOUNT &&
    Number(fields[2]) === VM_WORKSPACE_GUEST_UID &&
    Number(fields[3]) === VM_WORKSPACE_GUEST_GID &&
    (fields[6] === "/usr/sbin/nologin" || fields[6] === "/sbin/nologin" || fields[6] === "/bin/false")
  );
}

/** An unmapped high uid is safe for development. If the deployment reserves
 * it in NSS, it must be the exact locked account from the Razer contract. */
async function verifyDedicatedGuestIdentity(runner: CommandRunner): Promise<void> {
  for (const [database, id, kind] of [
    ["passwd", VM_WORKSPACE_GUEST_UID, "passwd"],
    ["group", VM_WORKSPACE_GUEST_GID, "group"],
  ] as const) {
    try {
      const { stdout } = await runner("/usr/bin/getent", [database, String(id)], 4_000);
      if (stdout.trim() && !safeDedicatedGuestIdentity(stdout, kind)) {
        throw new Error(`Local VM guest ${kind} ${id} belongs to another host identity`);
      }
    } catch (error) {
      // getent exits non-zero when an otherwise-safe high id is unmapped. A
      // mismatched mapped record is our own error and must remain fatal.
      if (error instanceof Error && error.message.includes("belongs to another host identity")) throw error;
    }
  }
}

async function validateWorkspaceLocation(target: LocalVmTarget, create: boolean): Promise<string> {
  if (!managedVmWorkspacePath(target.workspaceDir)) throw new Error("Local VM workspace escaped its managed data root");
  const workspaceRoot = workspaceRootForTarget(target);
  if (!CONFIGURED_VM_WORKSPACE_ROOT && create) {
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  }
  const rootInfo = await lstat(workspaceRoot);
  const canonicalRoot = await realpath(workspaceRoot);
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    (CONFIGURED_VM_WORKSPACE_ROOT !== null && canonicalRoot !== resolve(workspaceRoot))
  ) {
    throw new Error("Local VM workspace root must be one canonical directory");
  }
  if (dirname(resolve(target.workspaceDir)) !== resolve(workspaceRoot)) {
    throw new Error("Local VM workspace must be a direct child of its managed root");
  }
  if (create) {
    try {
      await mkdir(target.workspaceDir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const info = await lstat(target.workspaceDir);
  const canonical = await realpath(target.workspaceDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    dirname(canonical) !== canonicalRoot ||
    (CONFIGURED_VM_WORKSPACE_ROOT !== null && canonical !== resolve(target.workspaceDir)) ||
    info.dev !== rootInfo.dev
  ) {
    throw new Error("Local VM workspace must be one canonical directory on its bounded filesystem");
  }
  return canonical;
}

/** Production preparation entrypoint used by lifecycle code and deployment
 * acceptance. It validates the configured bounded root before invoking the
 * one authoritative ACL implementation. */
export async function ensureVmWorkspace(
  platform: NodeJS.Platform,
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner,
  storage: { ensure: (kind: "vm", key: string) => void } = { ensure: ensureStorageLeafSync },
): Promise<void> {
  // The privileged helper owns subvolume creation/quota assignment in the
  // hardened Razer deployment. It runs before even a best-effort mkdir.
  storage.ensure("vm", storageLeafKeyForTarget(target));
  const canonical = await validateWorkspaceLocation(target, true);
  if (platform === "linux" && runtime === "docker") {
    const serverUid = process.getuid?.();
    if (serverUid === undefined) throw new Error("Linux Docker workspace ACL needs the service UID");
    await verifyDedicatedGuestIdentity(runner);
    await applyLinuxDockerWorkspaceAcl(canonical, serverUid, runner);
  } else if (platform !== "win32") {
    await chmod(canonical, 0o700);
  }
}

/** A server-owned, networkless root helper container removes content even if
 * a hostile guest owns it and stripped every inherited ACL. The source path
 * is validated and hash-derived before this argv can be built. */
export function linuxDockerWorkspaceCleanupArgs(target: LocalVmTarget, cleanupName: string): string[] {
  if (!managedVmWorkspacePath(target.workspaceDir)) throw new Error("Local VM cleanup escaped its managed data root");
  if (!/^openmausbot-vm-cleanup-[a-f0-9]{16}$/.test(cleanupName)) throw new Error("invalid Local VM cleanup identity");
  return [
    "run",
    "--rm",
    "--name",
    cleanupName,
    "--network",
    "none",
    "--read-only",
    "--user",
    "0:0",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "64m",
    "--memory-swap",
    "64m",
    "--cpus",
    "0.25",
    "--ipc",
    "private",
    "--cgroupns",
    "private",
    "--mount",
    `type=bind,source=${target.workspaceDir},target=/workspace`,
    "--entrypoint",
    "/usr/bin/find",
    IMAGE,
    "/workspace",
    "-xdev",
    "-mindepth",
    "1",
    "-delete",
  ];
}

export async function deleteLocalVmWorkspace(
  target: LocalVmTarget,
  runtime: Runtime | null,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  storage: { retire: (kind: "vm", key: string) => Promise<void> } = { retire: retireStorageLeaf },
): Promise<void> {
  try {
    await validateWorkspaceLocation(target, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (platform === "linux" && runtime === "docker") {
    const cleanupName = `openmausbot-vm-cleanup-${randomBytes(8).toString("hex")}`;
    try {
      await runner("docker", linuxDockerWorkspaceCleanupArgs(target, cleanupName), 120_000);
    } finally {
      // `docker run --rm` normally removed itself. If the client timed out or
      // disconnected, force-removing the exact random name reaps the helper
      // before the durable path can be reused.
      await runner("docker", ["rm", "-f", cleanupName], 15_000).catch(() => {});
    }
  }
  // A hardened leaf is a Btrfs subvolume, so ordinary rm cannot retire it.
  // This happens only after the root-capable cleanup container proved the
  // hostile guest tree empty. In compatibility/dev mode retire is a no-op.
  await storage.retire("vm", storageLeafKeyForTarget(target));
  await rm(target.workspaceDir, { recursive: true, force: true });
}

async function prepareManagedImage(runtime: Runtime, runner: CommandRunner): Promise<void> {
  await runner(runtime, ["pull", BASE_IMAGE], 10 * 60_000);
  const context = await mkdtemp(join(tmpdir(), "openmausbot-cua-image-"));
  try {
    await writeFile(join(context, "Dockerfile"), managedImageDockerfile(), { mode: 0o600 });
    await runner(runtime, ["build", "-t", IMAGE, context], 10 * 60_000);
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

export async function containerComputerAction(
  action: LifecycleAction,
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<ContainerComputerStatus> {
  if (runner === sh && platform === process.platform) screenshotStatusCache.delete(target.key);
  const before = await containerComputerStatus(runner, platform, target);
  const runtime = before.runtime;
  if (!runtime) throw Object.assign(new Error(before.problem ?? "No container runtime is installed"), { status: 409 });
  if (!before.daemonUp) throw Object.assign(new Error(before.problem ?? `${runtime} is not running`), { status: 409 });

  if (action === "run" && before.container !== "missing") {
    throw Object.assign(new Error("A Local VM already exists; remove it before creating a replacement"), { status: 409 });
  }
  if (action === "run" && !before.image) {
    throw Object.assign(new Error("Prepare the Cua desktop image before creating the Local VM"), { status: 409 });
  }
  if (action === "run" && !before.create_supported) {
    throw Object.assign(new Error(before.problem ?? "This runtime cannot create a per-bot Local VM"), { status: 409 });
  }
  if (action === "start") {
    throw Object.assign(new Error("This desktop image cannot safely resume; remove and recreate the Local VM"), {
      status: 409,
    });
  }
  if (action === "stop" && before.container !== "running") {
    throw Object.assign(new Error("The Local VM is not running"), { status: 409 });
  }
  if (action === "remove" && before.container === "missing") {
    await removeLocalVmNetwork(runtime, target, runner);
    return before;
  }

  if (action === "pull") {
    await prepareManagedImage(runtime, runner);
  } else {
    if (action === "run") {
      await ensureVmWorkspace(platform, runtime, target, runner);
      await ensureLocalVmNetwork(runtime, target, runner, platform);
    }
    const args =
      action === "run"
        ? containerRunArgs(runtime, randomBytes(6).toString("base64url"), target)
        : action === "remove"
          ? ["rm", runtime === "container" ? "--force" : "-f", target.containerName]
          : [action, target.containerName];
    await runner(runtime, args, 2 * 60_000);
    if (action === "remove") await removeLocalVmNetwork(runtime, target, runner);
  }
  return containerComputerStatus(runner, platform, target);
}

/** Cheap capacity probe used by the per-bot pool. It deliberately checks an
 * exact derived container name rather than parsing a broad daemon listing. */
export async function containerComputerExists(
  runtime: Runtime,
  target: LocalVmTarget,
  runner: CommandRunner = sh,
): Promise<boolean> {
  try {
    await runner(runtime, ["inspect", target.containerName], 8_000);
    return true;
  } catch {
    return false;
  }
}

export type ScreenshotCheck = { ok: boolean; mime: "image/png" | "image/jpeg" };

/** Shared with the BYO-VPS backend: a truncated base64 transfer must never
 * become a "successful" preview frame on either transport. */
export function wholeScreenshot(bytes: Buffer): ScreenshotCheck {
  if (bytes.length < 512) return { ok: false, mime: "image/png" };
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (png) {
    return {
      ok: bytes.subarray(Math.max(0, bytes.length - 12)).includes(Buffer.from("IEND", "ascii")),
      mime: "image/png",
    };
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  return {
    ok: jpeg && bytes.subarray(Math.max(0, bytes.length - 32)).includes(Buffer.from([0xff, 0xd9])),
    mime: "image/jpeg",
  };
}

const screenshotQueues = new Map<string, Promise<void>>();

async function serializeScreenshot<T>(targetKey: string, capture: () => Promise<T>): Promise<T> {
  const previous = screenshotQueues.get(targetKey) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => turn);
  screenshotQueues.set(targetKey, tail);
  await previous.catch(() => {});
  try {
    return await capture();
  } finally {
    release();
    if (screenshotQueues.get(targetKey) === tail) screenshotQueues.delete(targetKey);
  }
}

export async function containerComputerScreenshot(
  runner: CommandRunner = sh,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
): Promise<string> {
  return serializeScreenshot(target.key, () => captureContainerComputerScreenshot(runner, platform, target));
}

async function captureContainerComputerScreenshot(
  runner: CommandRunner,
  platform: NodeJS.Platform,
  target: LocalVmTarget,
): Promise<string> {
  const cacheable = runner === sh && platform === process.platform;
  const now = Date.now();
  const cached = screenshotStatusCache.get(target.key);
  const status =
    cacheable && cached && cached.expiresAt > now
      ? cached.status
      : await containerComputerStatus(runner, platform, target);
  if (!status.ready || !status.runtime) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw Object.assign(new Error(status.problem ?? "The Local VM is not ready"), { status: 409 });
  }
  if (cacheable) screenshotStatusCache.set(target.key, { status, expiresAt: now + SCREENSHOT_STATUS_TTL_MS });
  try {
    const screenshot = "/tmp/openmausbot-preview.png";
    await runner(
      status.runtime,
      cuaExecArgs([
        "call",
        "get_desktop_state",
        "{}",
        "--socket",
        CUA_SOCKET,
        "--screenshot-out-file",
        screenshot,
      ], { container: target.containerName }),
      30_000,
    );
    const { stdout } = await runner(
      status.runtime,
      ["exec", target.containerName, "base64", "-w0", screenshot],
      30_000,
    );
    const data = stdout.trim();
    const checked = wholeScreenshot(Buffer.from(data, "base64"));
    if (!checked.ok) {
      throw Object.assign(new Error("Cua Driver returned an incomplete screenshot"), { status: 502 });
    }
    return `data:${checked.mime};base64,${data}`;
  } catch (error) {
    if (cacheable) screenshotStatusCache.delete(target.key);
    throw error;
  }
}

const screenshotStatusCache = new Map<
  string,
  { status: ContainerComputerStatus; expiresAt: number }
>();

const containerMcpPath = SPAWNED_PROXIES.containerMcp;

/** Spawn contract handed directly to agent runtimes. The provider receives
 * only an opaque, exact-turn bearer for the trusted server broker. Runtime,
 * container name, socket path, and Docker authority never cross this seam. */
type ContainerMcpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function containerComputerMcp(
  broker: { url: string; token: string },
): ContainerMcpLaunch {
  return {
    command: process.execPath,
    args: [containerMcpPath],
    // The bearer rides in env, not argv — argv is world-readable through
    // `ps`. The child deletes both values before opening the socket.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      OMB_LOCAL_VM_MCP_URL: broker.url,
      OMB_LOCAL_VM_MCP_CAPABILITY: broker.token,
    },
  };
}

/** Commands shown as a transparent fallback. Normal setup builds the pinned
 * derivative through the API, so users do not need to author a Dockerfile. */
export function setupCommands(
  runtime: Runtime | null,
  platform: NodeJS.Platform = process.platform,
  target: LocalVmTarget = SHARED_LOCAL_VM_TARGET,
) {
  const install =
    platform === "darwin"
      ? "brew install podman; podman machine init; podman machine start"
      : platform === "win32"
        ? "winget install -e --id RedHat.Podman-Desktop"
        : null;
  const runtimeStart =
    runtime === "container"
      ? "container system start"
      : runtime === "podman" && platform !== "linux"
        ? "podman machine init; podman machine start"
        : runtime === "docker" && platform === "darwin"
          ? "colima start || open -a Docker"
          : runtime === "docker" && platform === "linux"
            ? "sudo systemctl start docker"
            : null;

  if (!runtime) {
    return {
      install,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
    };
  }
  const command = (args: string[]) => [runtime, ...args].join(" ");
  return {
    install,
    runtimeStart,
    // This is the inspectable base download. The normal Prepare button also
    // builds the checksum-pinned 0.20.0 derivative automatically.
    pull: command(["pull", BASE_IMAGE]),
    run:
      runtime === "container" && target.key !== SHARED_LOCAL_VM_TARGET.key
        ? null
        : command(containerRunArgs(runtime, "CHANGE_ME", target)),
    start: null,
    stop: command(["stop", target.containerName]),
    remove: command(["rm", runtime === "container" ? "--force" : "-f", target.containerName]),
    view: target.viewerPort ? `http://127.0.0.1:${target.viewerPort}/vnc.html` : "",
  };
}

/** Cloud boxes still use OpenMausBot's high-latency REST adapter. Local VMs
 * bypass it and mount Cua Driver's official MCP server through
 * containerComputerMcp(). */
export function computerProxyEnv(
  computer: {
    boxId?: string;
    broker?: { url: string; token: string };
    control?: { url: string; token: string };
  },
): NodeJS.ProcessEnv {
  return {
    OGB_BOX_ID: computer.boxId ?? "",
    OMB_BOX_BROKER_URL: computer.broker?.url ?? "",
    OMB_BOX_CAPABILITY_TOKEN: computer.broker?.token ?? "",
    ...(computer.control
      ? { OMB_CONTROL_URL: computer.control.url, OMB_CONTROL_TOKEN: computer.control.token }
      : {}),
  };
}
