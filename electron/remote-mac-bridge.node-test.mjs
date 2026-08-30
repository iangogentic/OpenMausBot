import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureRemoteDeviceBridgeToken,
  ensureRemoteMacBridgeToken,
  startRemoteDeviceBridge,
  startRemoteMacBridge,
} from "./remote-mac-bridge.mjs";

test("retired token-file and reverse-port bridge APIs fail closed", async () => {
  assert.throws(() => ensureRemoteMacBridgeToken("/tmp/unused"), /retired for security/);
  assert.throws(() => ensureRemoteDeviceBridgeToken("/tmp/unused"), /retired for security/);
  await assert.rejects(() => startRemoteMacBridge(), /retired for security/);
  await assert.rejects(() => startRemoteDeviceBridge(), /retired for security/);
});
