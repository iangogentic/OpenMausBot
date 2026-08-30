import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createDesktopViewerRegistry,
  desktopViewerContextId,
} = require("./desktop-viewer-registry.cjs");

class FakeViewer {
  constructor(name) {
    this.name = name;
    this.destroyed = false;
    this.onClosed = null;
  }

  destroy() {
    this.destroyed = true;
    this.onClosed?.();
  }
}

function harness(maxViewers = 16) {
  const notifications = [];
  const registry = createDesktopViewerRegistry({
    maxViewers,
    destroyViewer: (viewer) => viewer.destroy(),
    isViewerDestroyed: (viewer) => viewer.destroyed,
    isOwnerDestroyed: (owner) => owner.destroyed,
    notifyOwner: (owner, state) => notifications.push({ owner: owner.name, ...state }),
  });
  const owner = { name: "main", destroyed: false };
  const install = (contextId, name = contextId) => {
    const viewer = new FakeViewer(name);
    const record = { owner, viewer };
    registry.install(contextId, record);
    viewer.onClosed = () => registry.handleClosed(record);
    return record;
  };
  return { install, notifications, owner, registry };
}

test("requires a bounded, nonempty, control-free context id", () => {
  assert.equal(desktopViewerContextId(" bot-a "), "bot-a");
  for (const value of [null, undefined, "", "   ", "bot\nother", "a".repeat(121)]) {
    assert.throws(() => desktopViewerContextId(value), /context/);
  }
});

test("bot A and bot B viewers coexist and report exact initial states", () => {
  const { install, owner, registry } = harness();
  const a = install("bot-a");
  const b = install("bot-b");
  assert.equal(a.viewer.destroyed, false);
  assert.equal(b.viewer.destroyed, false);
  assert.deepEqual(registry.state("bot-a", owner), { open: true, contextId: "bot-a" });
  assert.deepEqual(registry.state("bot-b", owner), { open: true, contextId: "bot-b" });
  assert.deepEqual(registry.states(owner), [
    { open: true, contextId: "bot-a" },
    { open: true, contextId: "bot-b" },
  ]);
});

test("reopening A replaces only A and closing A leaves B alive", () => {
  const { install, notifications, owner, registry } = harness();
  const a1 = install("bot-a", "a1");
  const b = install("bot-b");
  registry.notifyOpen(a1);
  registry.notifyOpen(b);

  const a2 = install("bot-a", "a2");
  assert.equal(a1.viewer.destroyed, true);
  assert.equal(a2.viewer.destroyed, false);
  assert.equal(b.viewer.destroyed, false);
  assert.equal(notifications.some((state) => state.contextId === "bot-a" && !state.open), false);

  assert.equal(registry.close("bot-a", owner), true);
  assert.deepEqual(registry.state("bot-a", owner), { open: false, contextId: "bot-a" });
  assert.deepEqual(registry.state("bot-b", owner), { open: true, contextId: "bot-b" });
  assert.equal(b.viewer.destroyed, false);
});

test("a stale A close callback cannot remove its replacement", () => {
  const { install, owner, registry } = harness();
  const a1 = install("bot-a", "a1");
  const staleClosed = a1.viewer.onClosed;
  const a2 = install("bot-a", "a2");
  staleClosed();
  assert.equal(registry.isCurrent(a2), true);
  assert.deepEqual(registry.state("bot-a", owner), { open: true, contextId: "bot-a" });
});

test("state notifications stay on the exact context and owner", () => {
  const { install, notifications, owner, registry } = harness();
  const a = install("bot-a");
  const b = install("bot-b");
  registry.notifyOpen(a);
  registry.notifyOpen(b);
  registry.close("bot-a", owner);
  assert.deepEqual(notifications, [
    { owner: "main", open: true, contextId: "bot-a" },
    { owner: "main", open: true, contextId: "bot-b" },
    { owner: "main", open: false, contextId: "bot-a" },
  ]);
  assert.deepEqual(registry.state("bot-b", owner), { open: true, contextId: "bot-b" });
});

test("another owner cannot inspect, close, or replace a viewer", () => {
  const { install, owner, registry } = harness();
  install("bot-a");
  const attacker = { name: "attacker", destroyed: false };
  assert.deepEqual(registry.state("bot-a", attacker), { open: false, contextId: "bot-a" });
  assert.equal(registry.close("bot-a", attacker), false);
  assert.throws(
    () => registry.install("bot-a", { owner: attacker, viewer: new FakeViewer("attacker") }),
    /different renderer document/,
  );
  assert.deepEqual(registry.state("bot-a", owner), { open: true, contextId: "bot-a" });
});

test("the per-process viewer count is bounded", () => {
  const { install } = harness(2);
  install("bot-a");
  install("bot-b");
  assert.throws(() => install("bot-c"), /At most 2/);
});
