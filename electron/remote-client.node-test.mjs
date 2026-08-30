import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readRemoteDeploymentConfig,
  readPrivateRemoteClientConfigDocument,
  removeLegacyBridgeSecrets,
  secureWindowsRemoteConfig,
} from "./remote-client.mjs";

test("remote deployment requires app-owned pinned SSH and independent sessions", () => {
  const sessionToken = "u".repeat(48);
  const companionSessionToken = "c".repeat(48);
  const hostPublicKey = `ssh-ed25519 ${Buffer.alloc(32, 9).toString("base64")}`;
  const config = readRemoteDeploymentConfig("/unused", () => JSON.stringify({
    mode: "remote",
    serverName: "Razer",
    companion: true,
    ssh: { host: "razer.tail.example", user: "ian", port: 22, hostPublicKey },
    sessionToken,
    companionSessionToken,
  }));
  assert.equal(config.serverName, "Razer");
  assert.equal(config.ssh.hostPublicKey, hostPublicKey);
  assert.equal(config.sessionToken, sessionToken);
  assert.equal(config.companionSessionToken, companionSessionToken);

  assert.throws(
    () => readRemoteDeploymentConfig("/unused", () => JSON.stringify({
      mode: "remote",
      serverUrl: "http://127.0.0.1:18799",
      sessionToken,
    })),
    /loopback URLs are retired/,
  );
  assert.throws(
    () => readRemoteDeploymentConfig("/unused", () => JSON.stringify({
      mode: "remote",
      companion: true,
      ssh: { host: "razer", user: "ian", hostPublicKey },
      sessionToken,
      companionSessionToken: sessionToken,
    })),
    /must differ/,
  );
});

test("requires the real remote config containing the bearer to be private and unlinked", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-private-remote-config-"));
  try {
    const file = path.join(directory, "remote-client.json");
    fs.writeFileSync(file, JSON.stringify({ mode: "remote", serverUrl: "http://127.0.0.1:18799" }), { mode: 0o600 });
    const expected = fs.readFileSync(file, "utf8");
    assert.equal(readPrivateRemoteClientConfigDocument(directory), expected);
    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o644);
      assert.throws(() => readPrivateRemoteClientConfigDocument(directory), /mode 0600/);
      fs.chmodSync(file, 0o600);
      const target = path.join(directory, "target.json");
      fs.renameSync(file, target);
      fs.symlinkSync(target, file);
      assert.throws(() => readPrivateRemoteClientConfigDocument(directory), /private regular file/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows validation applies a current-user-only ACL before use", () => {
  const calls = [];
  const stat = {
    dev: 1,
    ino: 2,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 2,
    uid: 0,
    mode: 0o666,
  };
  const fakeFileSystem = {
    constants: fs.constants,
    lstatSync: () => stat,
    openSync: () => 7,
    fstatSync: () => stat,
    readFileSync: () => "{}",
    closeSync: () => {},
  };
  assert.equal(
    readPrivateRemoteClientConfigDocument("C:\\profile", fakeFileSystem, {
      platform: "win32",
      secureWindowsFile: (file) => calls.push(file),
    }),
    "{}",
  );
  assert.equal(calls.length, 1);
});

test("Windows ACL replacement removes a pre-existing Everyone read grant", {
  skip: process.platform !== "win32",
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-windows-acl-"));
  try {
    const file = path.join(directory, "remote-client.json");
    fs.writeFileSync(file, "{}", { mode: 0o600 });
    const addForeign = spawnSync(
      "icacls.exe",
      [file, "/grant", "*S-1-1-0:(R)"],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(addForeign.status, 0, addForeign.stderr);
    secureWindowsRemoteConfig(file);
    const encodedPath = Buffer.from(file, "utf8").toString("base64");
    const inspect = [
      `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
      "$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$rules = @((Get-Acl -LiteralPath $p).Access)",
      "$sids = @($rules | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })",
      "[Console]::Out.Write((@{ count=$rules.Count; current=$me; sids=$sids } | ConvertTo-Json -Compress))",
    ].join("; ");
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(inspect, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    const acl = JSON.parse(result.stdout);
    assert.equal(acl.count, 1);
    assert.deepEqual(acl.sids, [acl.current]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the credential document is read from the same checked file handle", () => {
  const stat = (ino) => ({
    dev: 7,
    ino,
    uid: process.getuid?.() ?? -1,
    mode: 0o100600,
    size: 2,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  let closed = false;
  const racedFileSystem = {
    constants: fs.constants,
    lstatSync: () => stat(1),
    openSync: () => 42,
    fstatSync: () => stat(2),
    readFileSync: () => "{}",
    closeSync: () => { closed = true; },
  };
  assert.throws(
    () => readPrivateRemoteClientConfigDocument("/profile", racedFileSystem),
    /changed while it was being secured/,
  );
  assert.equal(closed, true);
});


test("removes retired reverse-port bridge bearers without following symlinks", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omb-retired-bridge-"));
  try {
    fs.writeFileSync(path.join(directory, "mac-bridge-token"), "retired", { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "device-bridge-token"), "retired", { mode: 0o600 });
    assert.equal(removeLegacyBridgeSecrets(directory), 2);
    assert.equal(fs.existsSync(path.join(directory, "mac-bridge-token")), false);
    assert.equal(fs.existsSync(path.join(directory, "device-bridge-token")), false);
    assert.equal(removeLegacyBridgeSecrets(directory), 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
