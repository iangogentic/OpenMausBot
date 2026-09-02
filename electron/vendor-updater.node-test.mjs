import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchAppImageUpdater } from "../scripts/patch-appimage-updater.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(root, "electron/vendor/electron-updater.cjs"), "utf8");

test("the vendored AppImage updater preserves the launched path", () => {
  assert.match(bundle, /destination = appImageFile;/);
  assert.doesNotMatch(bundle, /destination = (\w+)\.join\(\1\.dirname\(appImageFile\), \1\.basename\(installerPath\)\);/);
  assert.doesNotMatch(bundle, /unlinkSync\)\(appImageFile\)/);
  assert.match(bundle, /renameSync\)\(stagedDestination, destination\)/);
});

test("the AppImage patch fails closed if the upstream installer shape moves", () => {
  assert.throws(() => patchAppImageUpdater("unrecognised source"), /Expected exactly 1/);
});
