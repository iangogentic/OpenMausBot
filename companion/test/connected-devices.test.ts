import { describe, expect, it, vi } from "vitest";

import { createConnectedDeviceTracker } from "../src/connected-devices.ts";

describe("connected device tracker", () => {
  it("keeps a device live until every overlapping event stream closes", () => {
    const tracker = createConnectedDeviceTracker();
    const closeOldRoute = tracker.open("phone-1")!;
    const closeNewRoute = tracker.open("phone-1")!;
    const closeOtherPhone = tracker.open("phone-2")!;

    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeOldRoute();
    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);
    closeNewRoute();
    expect(tracker.ids()).toEqual(["phone-2"]);
    closeOtherPhone();
    expect(tracker.ids()).toEqual([]);
  });

  it("makes each stream cleanup idempotent", () => {
    const tracker = createConnectedDeviceTracker();
    const close = tracker.open("phone-1")!;

    close();
    close();
    expect(tracker.ids()).toEqual([]);
  });

  it("terminates every stream for a revoked device with idempotent cleanup", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateFirst = vi.fn();
    const terminateSecond = vi.fn();
    const closeFirst = tracker.open("phone-1", terminateFirst)!;
    const closeSecond = tracker.open("phone-1", terminateSecond)!;
    tracker.open("phone-2");

    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(tracker.ids()).toEqual(["phone-2"]);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();

    closeFirst();
    closeSecond();
    expect(tracker.disconnect("phone-1")).toBe(false);
    expect(terminateFirst).toHaveBeenCalledOnce();
    expect(terminateSecond).toHaveBeenCalledOnce();
  });

  it("aborts ordinary in-flight requests on revoke without making them event presence", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateChat = vi.fn();
    const terminateDesktop = vi.fn();
    const closeChat = tracker.openRequest("phone-1", terminateChat)!;
    const closeDesktop = tracker.openRequest("phone-1", terminateDesktop, { cloudDesktop: true })!;

    expect(tracker.ids()).toEqual([]);
    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(terminateChat).toHaveBeenCalledOnce();
    expect(terminateDesktop).toHaveBeenCalledOnce();
    closeChat();
    closeDesktop();
    expect(tracker.disconnect("phone-1")).toBe(false);
  });

  it("withdraws cloud desktop only from its pending requests", () => {
    const tracker = createConnectedDeviceTracker();
    const terminateChat = vi.fn();
    const terminateDesktop = vi.fn();
    tracker.openRequest("phone-1", terminateChat);
    tracker.openRequest("phone-1", terminateDesktop, { cloudDesktop: true });

    expect(tracker.disconnectCloudDesktop("phone-1")).toBe(true);
    expect(terminateDesktop).toHaveBeenCalledOnce();
    expect(terminateChat).not.toHaveBeenCalled();
    expect(tracker.disconnect("phone-1")).toBe(true);
    expect(terminateChat).toHaveBeenCalledOnce();
  });

  it("enforces per-device and global stream caps without disturbing siblings", () => {
    const tracker = createConnectedDeviceTracker({
      maxStreamsPerDevice: 2,
      maxStreamsGlobal: 3,
      maxRequestsPerDevice: 2,
      maxRequestsGlobal: 3,
    });
    const first = tracker.open("phone-1")!;
    expect(tracker.open("phone-1")).not.toBeNull();
    expect(tracker.open("phone-1")).toBeNull();
    expect(tracker.open("phone-2")).not.toBeNull();
    expect(tracker.open("phone-3")).toBeNull();
    expect(tracker.ids()).toEqual(["phone-1", "phone-2"]);

    first();
    expect(tracker.open("phone-3")).not.toBeNull();
    expect(tracker.ids()).toContain("phone-2");
  });

  it("enforces and reclaims per-device and global request slots", () => {
    const tracker = createConnectedDeviceTracker({
      maxStreamsPerDevice: 1,
      maxStreamsGlobal: 1,
      maxRequestsPerDevice: 2,
      maxRequestsGlobal: 3,
    });
    const first = tracker.openRequest("phone-1")!;
    expect(tracker.openRequest("phone-1")).not.toBeNull();
    expect(tracker.openRequest("phone-1")).toBeNull();
    expect(tracker.openRequest("phone-2")).not.toBeNull();
    expect(tracker.openRequest("phone-3")).toBeNull();

    first();
    expect(tracker.openRequest("phone-3")).not.toBeNull();
    expect(tracker.disconnect("phone-2")).toBe(true);
    expect(tracker.openRequest("phone-4")).not.toBeNull();
  });
});
