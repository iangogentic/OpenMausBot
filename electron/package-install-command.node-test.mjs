import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";

test("the Ubuntu hand-off resolves dependencies and quotes the package path", () => {
  assert.equal(
    packageInstallCommand("deb", "/home/o'brien/update file.deb"),
    "sudo apt-get install -y '/home/o'\\''brien/update file.deb'",
  );
});

test("every declared hand-off type has a command", () => {
  for (const type of HAND_OFF_PACKAGE_TYPES) assert.match(packageInstallCommand(type, "/tmp/pkg"), /^sudo /);
  assert.throws(() => packageInstallCommand("snap", "/tmp/pkg"), /No install command/);
});

test("a missing staged download never becomes an install command", () => {
  const workspace = mkdtempSync(join(tmpdir(), "omb-staged-"));
  try {
    const present = join(workspace, "OpenMausBot.deb");
    writeFileSync(present, "x");
    assert.equal(stagedInstallFile([join(workspace, "gone.deb"), present]), present);
    assert.throws(() => packageInstallCommand("deb", stagedInstallFile([])), /no longer available/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Linux package routing mirrors electron-updater", () => {
  const marker = (value) => () => value;
  assert.equal(linuxPackageType({ platform: "linux", resourcesPath: "/opt/app", readMarker: marker("deb\n") }), "deb");
  assert.equal(linuxPackageType({ platform: "linux", resourcesPath: "/opt/app", appImage: "/a.AppImage", readMarker: marker(null) }), "AppImage");
  assert.equal(linuxPackageType({ platform: "darwin", readMarker: marker("deb") }), null);
});
