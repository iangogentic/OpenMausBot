import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const REMOTE_CLIENT_CONFIG_FILE = "remote-client.json";

export function remoteClientConfigPath(userDataDir) {
  return path.join(userDataDir, REMOTE_CLIENT_CONFIG_FILE);
}

export function secureWindowsRemoteConfig(file, { spawnSyncImpl = spawnSync } = {}) {
  // Build a brand-new protected ACL containing only the current process
  // identity's SID. `icacls /grant:r USER:(F)` is not sufficient: it leaves
  // unrelated explicit ACEs (for example Everyone:Read) in place and a bare
  // USERNAME is ambiguous on domain-joined machines.
  const encodedPath = Buffer.from(file, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$acl = New-Object Security.AccessControl.FileSecurity",
    "$acl.SetOwner($sid)",
    "$acl.SetAccessRuleProtection($true, $false)",
    "$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')",
    "$acl.SetAccessRule($rule)",
    "Set-Acl -LiteralPath $p -AclObject $acl",
    "$check = Get-Acl -LiteralPath $p",
    "$rules = @($check.Access)",
    "if ($rules.Count -ne 1) { exit 41 }",
    "$actualSid = $rules[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value",
    "if ($actualSid -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].IsInherited) { exit 42 }",
  ].join("; ");
  const result = spawnSyncImpl(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error("The remote OpenMausBot config ACL could not be secured");
  }
}

function sameOpenedFile(before, opened) {
  // Node exposes stable inode/file-index values on all supported desktop
  // platforms. Bind the checked pathname to the exact opened handle so a
  // rename-to-symlink race cannot swap in another credential document.
  return before.dev === opened.dev && before.ino === opened.ino;
}

/** Validate and read the exact same filesystem object through one descriptor.
 * The second fstat also detects an in-place truncate/replace while reading. */
export function readPrivateRemoteClientConfigDocument(
  userDataDir,
  fileSystem = fs,
  {
    platform = process.platform,
    uid = process.getuid?.() ?? -1,
    secureWindowsFile = secureWindowsRemoteConfig,
  } = {},
) {
  const file = remoteClientConfigPath(userDataDir);
  const before = fileSystem.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > 64 * 1024) {
    throw new Error("The remote OpenMausBot config must be a private regular file");
  }
  if (platform === "win32") secureWindowsFile(file);

  let descriptor;
  try {
    const noFollow = platform === "win32" ? 0 : (fileSystem.constants?.O_NOFOLLOW ?? fs.constants.O_NOFOLLOW);
    descriptor = fileSystem.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fileSystem.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size < 2 ||
      opened.size > 64 * 1024 ||
      !sameOpenedFile(before, opened)
    ) {
      throw new Error("The remote OpenMausBot config changed while it was being secured");
    }
    if (platform !== "win32" && (opened.uid !== uid || (opened.mode & 0o077) !== 0)) {
      throw new Error("The remote OpenMausBot config must be owned by this user and mode 0600");
    }
    const document = fileSystem.readFileSync(descriptor, "utf8");
    const after = fileSystem.fstatSync(descriptor);
    if (!sameOpenedFile(opened, after) || after.size !== opened.size || Buffer.byteLength(document) !== opened.size) {
      throw new Error("The remote OpenMausBot config changed while it was being read");
    }
    return document;
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function readRemoteConfig(userDataDir, readFile) {
  const document = readFile === fs.readFileSync
    ? readPrivateRemoteClientConfigDocument(userDataDir)
    : readFile(remoteClientConfigPath(userDataDir), "utf8");
  return JSON.parse(document);
}

function requiredSessionToken(value, label) {
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error(`The remote OpenMausBot ${label} is missing`);
  }
  const token = value.trim();
  if (token !== value || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new Error(`The remote OpenMausBot ${label} is invalid`);
  }
  return token;
}

function remoteSshHost(value) {
  const dnsName = typeof value === "string" && value.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  );
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 253 ||
    (!dnsName && isIP(value) === 0)
  ) throw new Error("The remote OpenMausBot SSH host is invalid");
  return value;
}

function remoteSshPublicKey(value) {
  if (typeof value !== "string" || value.length > 4096) {
    throw new Error("The remote OpenMausBot SSH host public key is invalid");
  }
  const match = /^(ssh-ed25519|ecdsa-sha2-nistp256|rsa-sha2-512|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,512})?$/.exec(value);
  if (!match) throw new Error("The remote OpenMausBot SSH host public key is invalid");
  let decoded;
  try { decoded = Buffer.from(match[2], "base64"); } catch { decoded = null; }
  if (!decoded || decoded.length < 32 || decoded.length > 2048) {
    throw new Error("The remote OpenMausBot SSH host public key is invalid");
  }
  return `${match[1]} ${match[2]}`;
}

/** One atomic, main-process-only remote deployment document. Remote mode no
 * longer accepts a caller-managed loopback URL: the app must own the local
 * listener and every byte behind it must traverse pinned OpenSSH. */
export function readRemoteDeploymentConfig(userDataDir, readFile = fs.readFileSync) {
  let parsed;
  try {
    parsed = readRemoteConfig(userDataDir, readFile);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error("The remote OpenMausBot config is not valid JSON");
    throw error;
  }
  if (parsed?.mode !== "remote") return null;
  if (parsed.serverUrl !== undefined || parsed.companionUrl !== undefined) {
    throw new Error("Remote loopback URLs are retired; configure pinned SSH ownership instead");
  }
  if (!parsed.ssh || typeof parsed.ssh !== "object" || Array.isArray(parsed.ssh)) {
    throw new Error("The remote OpenMausBot config needs pinned SSH settings");
  }
  const sshKeys = Object.keys(parsed.ssh);
  if (sshKeys.some((key) => !["host", "user", "port", "hostPublicKey", "identityFile"].includes(key))) {
    throw new Error("The remote OpenMausBot SSH config contains unsupported fields");
  }
  const host = remoteSshHost(parsed.ssh.host);
  const user = typeof parsed.ssh.user === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(parsed.ssh.user)
    ? parsed.ssh.user
    : null;
  if (!user) throw new Error("The remote OpenMausBot SSH user is invalid");
  const port = parsed.ssh.port === undefined ? 22 : parsed.ssh.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("The remote OpenMausBot SSH port is invalid");
  }
  let identityFile = null;
  if (parsed.ssh.identityFile !== undefined) {
    if (
      typeof parsed.ssh.identityFile !== "string" ||
      !path.isAbsolute(parsed.ssh.identityFile) ||
      /[\0\r\n]/.test(parsed.ssh.identityFile) ||
      parsed.ssh.identityFile.length > 4096
    ) throw new Error("The remote OpenMausBot SSH identity file is invalid");
    identityFile = parsed.ssh.identityFile;
  }
  const sessionToken = requiredSessionToken(parsed.sessionToken, "sessionToken");
  const companionEnabled = parsed.companion === true;
  const companionSessionToken = companionEnabled
    ? requiredSessionToken(parsed.companionSessionToken, "companionSessionToken")
    : null;
  if (companionSessionToken === sessionToken) {
    throw new Error("The remote OpenMausBot companionSessionToken must differ from sessionToken");
  }
  let serverName = "Remote server";
  if (parsed.serverName !== undefined) {
    if (typeof parsed.serverName !== "string" || !parsed.serverName.trim() || parsed.serverName.trim().length > 80) {
      throw new Error("The remote OpenMausBot server name is invalid");
    }
    serverName = parsed.serverName.trim();
  }
  return Object.freeze({
    serverName,
    sessionToken,
    companionEnabled,
    companionSessionToken,
    ssh: Object.freeze({
      host,
      user,
      port,
      hostPublicKey: remoteSshPublicKey(parsed.ssh.hostPublicKey),
      identityFile,
    }),
  });
}

/** One-way migration from the retired reverse-port bridge. The new outbound
 * transport stores no device bearer on disk, so leaving either old token in
 * the app profile would preserve authority that has no legitimate caller. */
export function removeLegacyBridgeSecrets(userDataDir, fileSystem = fs) {
  let removed = 0;
  for (const name of ["mac-bridge-token", "device-bridge-token"]) {
    const file = path.join(userDataDir, name);
    try {
      const stat = fileSystem.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fileSystem.unlinkSync(file);
      removed += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}
