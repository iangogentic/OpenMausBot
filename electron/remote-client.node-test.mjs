import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRemoteServerURL,
  readRemoteClientConfig,
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
