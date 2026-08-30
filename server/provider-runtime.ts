import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const PROVIDER_HOME_KEYS = [
  "GROK_HOME",
  "GEMINI_HOME",
  "CODEX_HOME",
  "HERMES_HOME",
  "KIMI_CODE_HOME",
  "FACTORY_HOME_OVERRIDE",
] as const;

export const PROVIDER_INSTANCE_HOME_ENV = "OMB_PROVIDER_INSTANCE_HOME";
export const PROVIDER_INSTANCE_STATE_ENV = "OMB_PROVIDER_INSTANCE_STATE";

export interface ProviderInstanceIdentity {
  driverKind: string;
  instanceId: string;
}

function safeAbsoluteDirectory(raw: string | undefined, label: string): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  if (!isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} must be an absolute directory path`);
  }
  return resolve(value);
}

function inside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function identityDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function providerInstanceComponents(identity: ProviderInstanceIdentity): [string, string] {
  if (
    !identity ||
    !identity.driverKind ||
    !identity.instanceId ||
    identity.driverKind.length > 256 ||
    identity.instanceId.length > 1024
  ) {
    throw new Error("provider instance identity is invalid");
  }
  return [
    identityDigest(`driver\0${identity.driverKind}`).slice(0, 24),
    identityDigest(`instance\0${identity.driverKind}\0${identity.instanceId}`).slice(0, 32),
  ];
}

/** Stable, non-user-controlled filesystem mapping. Hash-only components keep
 * instance ids containing slashes, dots, Unicode, or shell punctuation from
 * becoming paths or aliases. */
export function providerInstanceHomePath(
  providerRoot: string,
  identity: ProviderInstanceIdentity,
): string {
  return join(providerRoot, "instances", ...providerInstanceComponents(identity));
}

/** Root-owned instance state namespace. A hostile child never sees this host
 * path: the supervisor masks the whole provider root and mounts only the one
 * hashed per-bot home selected by trusted spawn metadata. */
export function providerInstanceStatePath(
  providerStateRoot: string,
  identity: ProviderInstanceIdentity,
): string {
  return join(providerStateRoot, ...providerInstanceComponents(identity));
}

/** Runtime-only environment overlay for a provider launched under another
 * Unix identity. Driver auth checks, catalogs, config writes and the eventual
 * child must agree on the exact same home; sudo's target HOME cannot be the
 * first place that identity changes.
 */
export function providerInstanceEnvironment(
  instance: Record<string, string>,
  startup: NodeJS.ProcessEnv = process.env,
  identity?: ProviderInstanceIdentity,
) {
  const required = startup.OMB_REQUIRE_PROVIDER_ISOLATION === "1";
  const providerRoot = safeAbsoluteDirectory(startup.OMB_PROVIDER_HOME, "provider home root");
  if (!providerRoot) {
    if (required) throw new Error("provider OS isolation requires OMB_PROVIDER_HOME");
    return { ...instance };
  }
  if (process.platform === "win32") {
    throw new Error("provider OS isolation is not supported on Windows");
  }
  if (!identity) throw new Error("provider OS isolation requires a trusted provider instance identity");
  const providerStateRoot = safeAbsoluteDirectory(startup.OMB_PROVIDER_STATE_DIR, "provider state root");
  if (!providerStateRoot) {
    if (required) throw new Error("provider OS isolation requires OMB_PROVIDER_STATE_DIR");
    return { ...instance };
  }
  if (required && providerStateRoot !== join(providerRoot, "state")) {
    throw new Error("provider state root must be the isolated provider root's state directory");
  }
  const configuredHome = providerInstanceHomePath(providerRoot, identity);
  const configuredState = providerInstanceStatePath(providerStateRoot, identity);
  let home: string;
  let state: string;
  try {
    home = realpathSync(configuredHome);
    const info = lstatSync(home);
    if (
      home !== configuredHome ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o7777) !== 0o2750
    ) {
      throw new Error("unsafe mode");
    }
  } catch {
    throw new Error(`provider instance home is missing or unsafe: ${configuredHome}`);
  }
  try {
    state = realpathSync(configuredState);
    const info = lstatSync(state);
    if (
      state !== configuredState ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o7777) !== 0o750
    ) {
      throw new Error("unsafe mode");
    }
  } catch {
    throw new Error(`provider instance state is missing or unsafe: ${configuredState}`);
  }
  const next = Object.assign({}, instance, {
    HOME: home,
    USERPROFILE: home,
    [PROVIDER_INSTANCE_HOME_ENV]: home,
    [PROVIDER_INSTANCE_STATE_ENV]: state,
  });
  for (const key of PROVIDER_HOME_KEYS) {
    const configured = next[key]?.trim();
    if (!configured) continue;
    const path = safeAbsoluteDirectory(configured, key)!;
    if (required && !inside(home, path)) {
      throw new Error(`${key} must stay inside the isolated provider instance home`);
    }
    next[key] = path;
  }
  return next;
}

/** Validate the server-owned, provider-readable volatile directory. A
 * configured path is a deployment security boundary, so a symlink, wrong
 * owner, or group/world-writable base fails closed instead of falling back to
 * ordinary /tmp.
 */
export function providerRuntimeBase(startup: NodeJS.ProcessEnv = process.env): string | null {
  const base = safeAbsoluteDirectory(startup.OMB_PROVIDER_RUNTIME_DIR, "provider runtime directory");
  if (!base) {
    if (startup.OMB_REQUIRE_PROVIDER_ISOLATION === "1") {
      throw new Error("provider OS isolation requires OMB_PROVIDER_RUNTIME_DIR");
    }
    return null;
  }
  const stat = lstatSync(base);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(base) !== base ||
    (uid !== undefined && stat.uid !== uid) ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o050) !== 0o050
  ) {
    throw new Error("provider runtime directory must be server-owned, non-writable by group/other, and group-readable");
  }
  return base;
}

export interface ProviderTempDirectory {
  path: string;
  sharedAcrossUid: boolean;
}

/** Create one unpredictable, server-owned directory. In isolated deployment
 * its setgid parent gives it the runtime group and mode 0750 lets only that
 * group read/traverse it; ordinary desktop/dev mode retains private 0700.
 */
export function createProviderTempDirectory(prefix: string): ProviderTempDirectory {
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(prefix)) throw new Error("provider temp prefix is invalid");
  const base = providerRuntimeBase();
  const path = mkdtempSync(join(base ?? tmpdir(), prefix));
  const sharedAcrossUid = Boolean(base);
  chmodSync(path, sharedAcrossUid ? 0o2750 : 0o700);
  return { path, sharedAcrossUid };
}

export function writeProviderRuntimeFile(
  directory: ProviderTempDirectory,
  name: string,
  contents: string,
): string {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error("provider runtime filename is invalid");
  const path = join(directory.path, name);
  writeFileSync(path, contents, { mode: directory.sharedAcrossUid ? 0o640 : 0o600, flag: "wx" });
  chmodSync(path, directory.sharedAcrossUid ? 0o640 : 0o600);
  return path;
}

export function providerRuntimeSocketBase(fallback: string): string {
  return providerRuntimeBase() ?? fallback;
}

export function publishProviderRuntimeSocket(path: string): void {
  if (providerRuntimeBase()) chmodSync(path, 0o660);
}
