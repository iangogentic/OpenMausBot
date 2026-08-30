import assert from "node:assert/strict";
import test from "node:test";

import { shouldStartUpdater } from "./updater-policy.mjs";

test("the packaged Razer remote shell cannot initialize the normal updater", () => {
  assert.equal(shouldStartUpdater({ packaged: true, remotePackage: true, platform: "darwin" }), false);
});

test("normal signed macOS and Linux packages keep updates while development stays dormant", () => {
  assert.equal(shouldStartUpdater({ packaged: true, remotePackage: false, platform: "darwin" }), true);
  assert.equal(shouldStartUpdater({ packaged: true, remotePackage: false, platform: "linux" }), true);
  assert.equal(shouldStartUpdater({ packaged: false, remotePackage: false, platform: "darwin" }), false);
  assert.equal(shouldStartUpdater({ packaged: false, remotePackage: true, platform: "darwin" }), false);
});

test("unsigned Windows packages never initialize the updater", () => {
  assert.equal(shouldStartUpdater({ packaged: true, remotePackage: false, platform: "win32" }), false);
  assert.equal(shouldStartUpdater({ packaged: true, remotePackage: true, platform: "win32" }), false);
});
