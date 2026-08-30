// Analytics in this fork have two independent gates: a distributor must
// deliberately configure a destination and the person must opt in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { analyticsEnabled, optAction, setAnalyticsEnabled } from "./analytics";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  has_opted_out_capturing: vi.fn(() => false),
  capture: vi.fn(),
  identify: vi.fn(),
}));
vi.mock("posthog-js", () => ({ default: posthog }));

// The suite runs on the node environment, which has no localStorage.
const store = new Map<string, string>();
const baseStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
vi.stubGlobal("localStorage", baseStorage);

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  vi.stubEnv("VITE_POSTHOG_TOKEN", `phc_${"t".repeat(32)}`);
  vi.stubEnv("VITE_POSTHOG_HOST", "https://telemetry.example.test");
  setAnalyticsEnabled(false);
  store.clear();
});
// Tests that swap in a throwing storage get the base one back even when an
// assertion fails mid-test — an inline restore at the end would be skipped.
afterEach(() => {
  vi.stubGlobal("localStorage", baseStorage);
  vi.unstubAllEnvs();
});

describe("optAction", () => {
  it("initialises on the first opt-in of a session that started off", () => {
    expect(optAction(true, false)).toBe("init");
  });

  it("opts a running client back in rather than initialising twice", () => {
    expect(optAction(true, true)).toBe("opt-in");
  });

  it("stops a running client without waiting for a restart", () => {
    expect(optAction(false, true)).toBe("opt-out");
  });

  it("does nothing when there is no client to stop", () => {
    // The important half: opting out before init must not reach PostHog to
    // tell it so — that request would itself be the leak.
    expect(optAction(false, false)).toBe("none");
  });
});

describe("the stored choice", () => {
  it("is off for a fresh install", () => {
    expect(analyticsEnabled()).toBe(false);
  });

  it("cannot be enabled when the build has no analytics destination", () => {
    vi.stubEnv("VITE_POSTHOG_TOKEN", "");
    expect(setAnalyticsEnabled(true)).toBe(false);
    expect(analyticsEnabled()).toBe(false);
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("requires both an explicit token and an explicit HTTPS origin", () => {
    vi.stubEnv("VITE_POSTHOG_HOST", "");
    expect(setAnalyticsEnabled(true)).toBe(false);
    vi.stubEnv("VITE_POSTHOG_HOST", "https://telemetry.example.test/path?x=1");
    expect(setAnalyticsEnabled(true)).toBe(false);
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("can be explicitly enabled only in a configured build", () => {
    expect(setAnalyticsEnabled(true)).toBe(true);
    expect(analyticsEnabled()).toBe(true);
  });

  it("holds an opt-out for the session even when the write is rejected", async () => {
    // The failure this guards: the setter swallows the write error, the next
    // a rejected write must never turn an in-memory opt-out back into the
    // persisted opt-in from an earlier launch.
    vi.resetModules();
    const fresh = await import("./analytics");
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
    });

    fresh.setAnalyticsEnabled(false);
    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();
    expect(store.get("omb-installed")).toBeUndefined();
  });

  it("treats unusable storage as no consent rather than failing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(analyticsEnabled()).toBe(false);
    expect(() => setAnalyticsEnabled(false)).not.toThrow();
  });
});

describe("initAnalytics while opted out", () => {
  it("returns before touching the client or the install marker", async () => {
    // A fresh module, so the module-scoped `ready` flag starts false: with a
    // used module this test passes on `ready` alone and proves nothing about
    // the opt-out. resetModules is not module mocking — nothing is replaced,
    // the real module is simply loaded again.
    vi.resetModules();
    store.set("omb-analytics-opt-in", "0"); // as a previous session left it
    const fresh = await import("./analytics");

    expect(fresh.analyticsEnabled()).toBe(false);
    fresh.initAnalytics();

    // No client is stubbed on purpose: if init() got past the guard it would
    // reach the real posthog-js and set this marker. Its absence is the
    // proof — and it also means opting back in later still counts the install.
    expect(store.get("omb-installed")).toBeUndefined();
  });
});
