import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRemoteServerURL,
  readRemoteClientConfig,
  readRemoteCompanionConfig,
  readRemoteMacBridgeConfig,
  readRemoteServerName,
  resolveRemoteCompanionURL,
  resolveRemoteClientURL,
} from "./remote-client.mjs";

test("normalizes a loopback SSH tunnel and secure remote origin", () => {
  assert.equal(normalizeRemoteServerURL("http://127.0.0.1:18799/"), "http://127.0.0.1:18799");
  assert.equal(normalizeRemoteServerURL("https://razer.example.com"), "https://razer.example.com");
});

test("rejects cleartext remote origins and ambiguous paths", () => {
  assert.throws(() => normalizeRemoteServerURL("http://100.79.178.47:8799"), /must use HTTPS/);
  assert.throws(() => normalizeRemoteServerURL("https://razer.example.com/admin"), /without a path/);
  assert.throws(() => normalizeRemoteServerURL("https://user:secret@razer.example.com"), /credentials/);
});

test("reads only an explicit remote-mode config", () => {
  const remote = readRemoteClientConfig("/unused", () =>
    JSON.stringify({ mode: "remote", serverUrl: "http://localhost:18799" }),
  );
  assert.equal(remote, "http://localhost:18799");
  assert.equal(
    readRemoteClientConfig("/unused", () => JSON.stringify({ mode: "local" })),
    null,
  );
});

test("CLI overrides environment and durable configuration", () => {
  assert.equal(
    resolveRemoteClientURL({
      argv: ["electron", ".", "--remote-server=http://127.0.0.1:3000"],
      env: { OMB_REMOTE_URL: "http://127.0.0.1:4000" },
      userDataDir: "/unused",
      readFile: () => JSON.stringify({ mode: "remote", serverUrl: "http://127.0.0.1:5000" }),
    }),
    "http://127.0.0.1:3000",
  );
});

test("resolves a tunneled companion control plane", () => {
  const readFile = () => JSON.stringify({
    mode: "remote",
    serverUrl: "http://127.0.0.1:18799",
    companionUrl: "http://127.0.0.1:8811",
  });
  assert.equal(readRemoteCompanionConfig("/unused", readFile), "http://127.0.0.1:8811");
  assert.equal(
    resolveRemoteCompanionURL({
      env: { OMB_REMOTE_COMPANION_URL: "http://127.0.0.1:18811" },
      userDataDir: "/unused",
      readFile,
    }),
    "http://127.0.0.1:18811",
  );
});

test("enables the physical Mac bridge only through explicit durable configuration", () => {
  assert.deepEqual(
    readRemoteMacBridgeConfig("/unused", () =>
      JSON.stringify({ mode: "remote", macBridge: { enabled: true, port: 18798 } }),
    ),
    { enabled: true, port: 18798 },
  );
  assert.equal(
    readRemoteMacBridgeConfig("/unused", () => JSON.stringify({ mode: "remote" })),
    null,
  );
  assert.throws(
    () => readRemoteMacBridgeConfig("/unused", () =>
      JSON.stringify({ mode: "remote", macBridge: { enabled: true, port: 80 } }),
    ),
    /port is invalid/,
  );
});

test("reads a short display name for the remote server", () => {
  assert.equal(
    readRemoteServerName("/unused", () => JSON.stringify({ mode: "remote", serverName: " Razer " })),
    "Razer",
  );
  assert.equal(readRemoteServerName("/unused", () => JSON.stringify({ mode: "remote" })), null);
  assert.throws(
    () => readRemoteServerName("/unused", () => JSON.stringify({ mode: "remote", serverName: "" })),
    /name is invalid/,
  );
});
