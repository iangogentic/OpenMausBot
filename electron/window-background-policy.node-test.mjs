import assert from "node:assert/strict";
import test from "node:test";

import policyModule from "./window-background-policy.cjs";

const { activateWindow, backgroundMenuTemplate, createWindowBackgroundPolicy } = policyModule;

test("macOS red-close hides until an explicit quit, while other platforms close", () => {
  const mac = createWindowBackgroundPolicy("darwin");
  assert.equal(mac.shouldHideOnClose(), true);
  mac.requestQuit();
  assert.equal(mac.shouldHideOnClose(), false);

  for (const platform of ["win32", "linux", "freebsd"]) {
    assert.equal(createWindowBackgroundPolicy(platform).shouldHideOnClose(), false);
  }
});

test("activation restores, shows and focuses exactly one existing window", () => {
  const calls = [];
  const window = {
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  assert.equal(activateWindow(window), true);
  assert.deepEqual(calls, ["restore", "show", "focus"]);
  assert.equal(activateWindow({ isDestroyed: () => true }), false);
  assert.equal(activateWindow(null), false);
});

test("menu-bar copy makes background lifetime and disconnection explicit", () => {
  const open = () => {};
  const quit = () => {};
  const menu = backgroundMenuTemplate({ serverName: "Razer", open, quit });
  assert.deepEqual(menu, [
    { label: "Open OpenMausBot", click: open },
    { type: "separator" },
    { label: "Agent work continues on Razer", enabled: false },
    { label: "Quit and disconnect this computer", click: quit },
  ]);
});
