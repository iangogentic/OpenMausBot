import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserDesktopViewerIsOpen,
  clearBrowserDesktopViewers,
  closeBrowserDesktopViewer,
  focusBrowserDesktopViewer,
  onBrowserDesktopViewerState,
  pollBrowserDesktopViewers,
  trackBrowserDesktopViewer,
} from "./browser-desktop-viewer";

function viewer() {
  const handle = {
    closed: false,
    close: vi.fn(() => { handle.closed = true; }),
    focus: vi.fn(),
  };
  return handle;
}

describe("plain-browser desktop viewer lifecycle", () => {
  afterEach(() => clearBrowserDesktopViewers());

  it("keeps viewer state outside the panel and focuses an existing tab", () => {
    const handle = viewer();
    const states: Array<[string, boolean]> = [];
    const off = onBrowserDesktopViewerState((...state) => states.push(state));
    trackBrowserDesktopViewer("bot-a", handle, vi.fn());
    expect(browserDesktopViewerIsOpen("bot-a")).toBe(true);
    expect(focusBrowserDesktopViewer("bot-a")).toBe(true);
    expect(handle.focus).toHaveBeenCalledOnce();
    expect(states).toEqual([["bot-a", true]]);
    off();
  });

  it("releases once when the person closes the tab", async () => {
    const handle = viewer();
    const release = vi.fn();
    trackBrowserDesktopViewer("bot-a", handle, release);
    handle.closed = true;
    pollBrowserDesktopViewers();
    await Promise.resolve();
    expect(release).toHaveBeenCalledOnce();
    expect(browserDesktopViewerIsOpen("bot-a")).toBe(false);
    pollBrowserDesktopViewers();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not double-release after an explicit hand-back", () => {
    const handle = viewer();
    const release = vi.fn();
    trackBrowserDesktopViewer("bot-a", handle, release);
    expect(closeBrowserDesktopViewer("bot-a")).toBe(true);
    pollBrowserDesktopViewers();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("replaces an old tab without letting its close release the new tab", async () => {
    const oldHandle = viewer();
    const nextHandle = viewer();
    const oldRelease = vi.fn();
    const nextRelease = vi.fn();
    trackBrowserDesktopViewer("bot-a", oldHandle, oldRelease);
    trackBrowserDesktopViewer("bot-a", nextHandle, nextRelease);
    expect(oldHandle.close).toHaveBeenCalledOnce();
    pollBrowserDesktopViewers();
    expect(oldRelease).not.toHaveBeenCalled();
    nextHandle.closed = true;
    pollBrowserDesktopViewers();
    await Promise.resolve();
    expect(nextRelease).toHaveBeenCalledOnce();
  });
});
