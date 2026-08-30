"use strict";

/**
 * macOS convention is to keep an app alive when its last visible window is
 * closed. OpenMausBot relies on that background lifetime for notifications
 * and the attended physical-computer bridge, so make the distinction between
 * hiding and actually quitting explicit and testable.
 */
function createWindowBackgroundPolicy(platform) {
  let quitRequested = false;
  return {
    requestQuit() {
      quitRequested = true;
    },
    get quitRequested() {
      return quitRequested;
    },
    shouldHideOnClose() {
      return platform === "darwin" && !quitRequested;
    },
  };
}

/** One shared path for Dock activation, menu-bar activation and a second app
 * launch. Hidden and minimized windows are surfaced instead of duplicated. */
function activateWindow(window) {
  if (!window || window.isDestroyed?.()) return false;
  if (window.isMinimized?.()) window.restore?.();
  window.show?.();
  window.focus?.();
  return true;
}

function backgroundMenuTemplate({ serverName, open, quit }) {
  const destination = typeof serverName === "string" && serverName.trim()
    ? serverName.trim().slice(0, 80)
    : "the remote server";
  return [
    { label: "Open OpenMausBot", click: open },
    { type: "separator" },
    { label: `Agent work continues on ${destination}`, enabled: false },
    { label: "Quit and disconnect this computer", click: quit },
  ];
}

module.exports = {
  activateWindow,
  backgroundMenuTemplate,
  createWindowBackgroundPolicy,
};
