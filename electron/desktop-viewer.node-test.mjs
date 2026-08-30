import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  desktopViewerUrl,
  sameDesktopViewerOrigin,
  desktopViewerNavigationAllowed,
  desktopViewerLoadFailureLabel,
  desktopViewerNeedsRfbProof,
  desktopViewerRequestAllowed,
  bindDesktopViewerNavigation,
  bindDesktopViewerToOwner,
} = require("./desktop-viewer.cjs");

test("accepts a secret-bearing trusted Box HTTPS VNC URL", () => {
  const url = desktopViewerUrl("https://desktop.box.ascii.dev/vnc.html?_token=secret");
  assert.equal(url.origin, "https://desktop.box.ascii.dev");
});

test("accepts Local VM viewers on loopback", () => {
  assert.equal(desktopViewerUrl("http://127.0.0.1:6080/vnc.html#password=x").port, "6080");
  assert.equal(desktopViewerUrl("http://localhost:6080/vnc.html").hostname, "localhost");
  assert.equal(
    desktopViewerUrl("http://openmaus-viewer.localhost:18799/vnc.html").hostname,
    "openmaus-viewer.localhost",
  );
});

test("rejects insecure remote and privileged URLs", () => {
  assert.throws(() => desktopViewerUrl("http://desktop.box.ascii.dev/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("file:///tmp/vnc.html"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("data:text/html,hello"), /HTTPS/);
  assert.throws(() => desktopViewerUrl("https://127.0.0.1.nip.io/vnc.html"), /configured Box provider/);
  assert.throws(() => desktopViewerUrl("https://attacker.example/vnc.html"), /configured Box provider/);
});

test("rejects URL user info", () => {
  assert.throws(() => desktopViewerUrl("https://user:password@desktop.box.ascii.dev/vnc.html"), /user info/);
});

test("allows only same-origin viewer navigation", () => {
  assert.equal(sameDesktopViewerOrigin("https://desktop.box.ascii.dev/session", "https://desktop.box.ascii.dev"), true);
  assert.equal(sameDesktopViewerOrigin("https://other.ascii.dev/session", "https://desktop.box.ascii.dev"), false);
  assert.equal(sameDesktopViewerOrigin("javascript:alert(1)", "https://desktop.box.ascii.dev"), false);
});

test("never lets hosted viewer content launch an external browser or escape its origin", () => {
  const viewer = "https://desktop.box.ascii.dev/session/token";
  assert.equal(desktopViewerNavigationAllowed(viewer, "https://desktop.box.ascii.dev/next"), true);
  assert.equal(desktopViewerNavigationAllowed(viewer, "https://phish.example/"), false);
  assert.equal(desktopViewerNavigationAllowed(viewer, "https://127.0.0.1:8799/api/config"), false);
  assert.equal(desktopViewerNavigationAllowed(viewer, "https://desktop.box.ascii.dev/popup", true), false);
});

test("never writes viewer tokens or passwords from navigation errors to logs", () => {
  const secret = "viewer-token-should-not-appear";
  const label = desktopViewerLoadFailureLabel({
    code: -105,
    message: `ERR_NAME_NOT_RESOLVED loading 'https://desktop.box.ascii.dev/${secret}/vnc.html#password=hunter2'`,
  });
  assert.equal(label, "[desktop-viewer] live desktop failed to load (code -105)");
  assert.equal(label.includes(secret), false);
  assert.equal(label.includes("hunter2"), false);
});

test("requires an actual RFB connection for bundled noVNC pages", () => {
  assert.equal(desktopViewerNeedsRfbProof("http://127.0.0.1:6080/vnc.html#autoconnect=true"), true);
  assert.equal(desktopViewerNeedsRfbProof("http://openmaus-viewer.localhost:18799/vnc.html"), true);
  assert.equal(desktopViewerNeedsRfbProof("https://desktop.box.ascii.dev/vnc.html?token=hosted"), false);
  assert.equal(desktopViewerNeedsRfbProof("https://desktop.box.ascii.dev/session/abc"), false);
  assert.equal(desktopViewerNeedsRfbProof("https://desktop.box.ascii.dev/not-vnc.html"), false);
});

test("confines bundled noVNC requests to the exact tokenized viewer namespace", () => {
  const token = "a".repeat(43);
  const viewer = `http://openmaus-viewer.localhost:18799/api/bots/bot-a/local-computer/viewer/${token}/vnc.html`;
  assert.equal(desktopViewerRequestAllowed(viewer, viewer), true);
  assert.equal(
    desktopViewerRequestAllowed(
      viewer,
      `http://openmaus-viewer.localhost:18799/api/bots/bot-a/local-computer/viewer/${token}/app/ui.js`,
    ),
    true,
  );
  assert.equal(
    desktopViewerRequestAllowed(
      viewer,
      `ws://openmaus-viewer.localhost:18799/api/bots/bot-a/local-computer/viewer/${token}/websockify`,
    ),
    true,
  );
  assert.equal(desktopViewerRequestAllowed(viewer, "http://openmaus-viewer.localhost:18799/api/config"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "http://127.0.0.1:18799/api/config"), false);
  assert.equal(
    desktopViewerRequestAllowed(
      viewer,
      `http://openmaus-viewer.localhost:18799/api/bots/bot-b/local-computer/viewer/${"b".repeat(43)}/vnc.html`,
    ),
    false,
  );
});

test("hosted viewers may use only their exact trusted TLS authority", () => {
  // A provider is free to call its hosted page vnc.html; the path alone must
  // not misclassify it as OpenMaus' tokenized loopback proxy.
  const viewer = "https://desktop.box.ascii.dev/vnc.html?token=hosted";
  assert.equal(desktopViewerRequestAllowed(viewer, viewer), true);
  assert.equal(desktopViewerRequestAllowed(viewer, "https://cdn.ascii.dev/viewer.js"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "wss://desktop.box.ascii.dev/socket"), true);
  assert.equal(desktopViewerRequestAllowed(viewer, "http://127.0.0.1:8799/api/config"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "https://127.0.0.1:8799/api/config"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "https://100.79.178.47/private"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "https://openmaus-viewer.localhost:18799/api/config"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "https://127.0.0.1.nip.io/private"), false);
  assert.equal(desktopViewerRequestAllowed(viewer, "file:///etc/passwd"), false);
});

test("hosted viewers reject every IP literal, including public IPv6", () => {
  const viewer = "https://desktop.box.ascii.dev/session/token";
  for (const target of [
    "https://[::]/api/config",
    "wss://[::ffff:127.0.0.1]/socket",
    "https://[::ffff:10.0.0.1]/private",
    "https://[::ffff:192.168.1.2]/private",
    "https://[fe80::1]/private",
    "https://[fd00::1]/private",
  ]) {
    assert.equal(desktopViewerRequestAllowed(viewer, target), false, target);
  }
  assert.equal(desktopViewerRequestAllowed(viewer, "https://[2606:4700:4700::1111]/viewer.js"), false);
});

test("closes the authority window on a cross-origin HTTP redirect", () => {
  const contents = new EventEmitter();
  let closes = 0;
  let prevented = 0;
  const unbind = bindDesktopViewerNavigation(
    contents,
    "https://desktop.box.ascii.dev/session/token",
    () => { closes += 1; },
  );
  contents.emit("will-redirect", { preventDefault: () => { prevented += 1; } }, "https://desktop.box.ascii.dev/next", false, true);
  assert.equal(closes, 0);
  contents.emit("will-redirect", { preventDefault: () => { prevented += 1; } }, "https://other.example/phish", false, true);
  assert.equal(prevented, 1);
  assert.equal(closes, 1);
  unbind();
});

test("final main-frame navigation validation fails closed after a missed preventative event", () => {
  const contents = new EventEmitter();
  let closes = 0;
  const unbind = bindDesktopViewerNavigation(
    contents,
    "https://desktop.box.ascii.dev/session/token",
    () => { closes += 1; },
  );
  contents.emit("did-frame-navigate", {}, "https://frame.other.example/", 200, "OK", false);
  assert.equal(closes, 0);
  contents.emit("did-navigate", {}, "https://redirect.other.example/", 200, "OK");
  contents.emit("did-frame-navigate", {}, "https://another.example/", 200, "OK", true);
  assert.equal(closes, 1);
  unbind();
});

test("closes a viewer when its owning renderer document reloads or dies", () => {
  const owner = new EventEmitter();
  let closes = 0;
  const unbind = bindDesktopViewerToOwner(owner, () => { closes += 1; });
  owner.emit("did-start-navigation", {}, "https://app/frame", false, false);
  owner.emit("did-start-navigation", {}, "https://app/#same-document", true, true);
  assert.equal(closes, 0);
  owner.emit("did-start-navigation", {}, "https://app/reloaded", false, true);
  owner.emit("render-process-gone");
  assert.equal(closes, 1);
  unbind();
  owner.emit("destroyed");
  assert.equal(closes, 1);
});

test("closes a viewer when its owner is destroyed without navigation", () => {
  const owner = new EventEmitter();
  let closes = 0;
  bindDesktopViewerToOwner(owner, () => { closes += 1; });
  owner.emit("destroyed");
  assert.equal(closes, 1);
});
