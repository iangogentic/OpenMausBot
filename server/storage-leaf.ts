import { execFile, execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export type StorageLeafKind = "workspace" | "vm";

const SAFE_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const SUDO = "/usr/bin/sudo";

function checkedKey(kind: StorageLeafKind, key: string): string {
  const valid = kind === "workspace"
    ? /^[A-Za-z0-9_-]{1,128}$/.test(key)
    : /^(?:shared|[a-f0-9]{16})$/.test(key);
  if (!valid) throw new Error(`invalid ${kind} storage identity`);
  return key;
}

function configuredHelper(startup: NodeJS.ProcessEnv): string | null {
  const helper = startup.OMB_STORAGE_LEAF_HELPER?.trim() ?? "";
  const required = startup.OMB_REQUIRE_STORAGE_ISOLATION === "1";
  if (!helper) {
    if (required) throw new Error("bounded storage isolation requires OMB_STORAGE_LEAF_HELPER");
    return null;
  }
  if (process.platform === "win32" || !isAbsolute(helper) || /[\0\r\n]/.test(helper)) {
    throw new Error("bounded storage helper path is invalid");
  }
  let info;
  try {
    info = lstatSync(helper);
  } catch {
    throw new Error("bounded storage helper must be a root-owned immutable executable");
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    realpathSync(helper) !== helper ||
    info.uid !== 0 ||
    !(info.mode & 0o111) ||
    info.mode & 0o022
  ) {
    throw new Error("bounded storage helper must be a root-owned immutable executable");
  }
  return helper;
}

export function storageLeafArguments(
  operation: "ensure" | "retire",
  kind: StorageLeafKind,
  key: string,
): string[] {
  return [`--${operation}-${kind}`, checkedKey(kind, key)];
}

/** Provision and revalidate one exact Btrfs subvolume before the caller opens
 * it. The root helper reapplies its hard qgroup ceiling on every invocation. */
export function ensureStorageLeafSync(
  kind: StorageLeafKind,
  key: string,
  startup: NodeJS.ProcessEnv = process.env,
): void {
  const args = storageLeafArguments("ensure", kind, key);
  const helper = configuredHelper(startup);
  if (!helper) return;
  execFileSync(SUDO, ["-n", "--", helper, ...args], {
    env: SAFE_ENV,
    stdio: "pipe",
    timeout: 15_000,
    windowsHide: true,
  });
}

/** Remove one exact stopped bot leaf. Retirement happens before the bot store
 * commits deletion so a quota/state cleanup failure remains visible. */
export async function retireStorageLeaf(
  kind: StorageLeafKind,
  key: string,
  startup: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const args = storageLeafArguments("retire", kind, key);
  const helper = configuredHelper(startup);
  if (!helper) return;
  await new Promise<void>((resolve, reject) => {
    execFile(SUDO, ["-n", "--", helper, ...args], {
      env: SAFE_ENV,
      timeout: 30_000,
      windowsHide: true,
    }, (error) => error ? reject(error) : resolve());
  });
}
