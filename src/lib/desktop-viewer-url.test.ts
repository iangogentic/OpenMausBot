import { describe, expect, it } from "vitest";

import { DESKTOP_VIEWER_HOST, resolveDesktopViewerUrl } from "./desktop-viewer-url";

const token = "a".repeat(43);
const path = `/api/bots/bot-a/local-computer/viewer/${token}/vnc.html#autoconnect=true`;

describe("desktop viewer URL boundary", () => {
  it("moves a tokenized local viewer onto the isolated localhost origin", () => {
    const result = new URL(resolveDesktopViewerUrl({
      rawUrl: path,
      appUrl: "http://127.0.0.1:18799/chat",
      botId: "bot-a",
      transport: "proxied",
    }));
    expect(result.hostname).toBe(DESKTOP_VIEWER_HOST);
    expect(result.port).toBe("18799");
    expect(result.pathname).toContain(`/viewer/${token}/vnc.html`);
  });

  it("accepts only HTTPS for a hosted provider viewer", () => {
    expect(resolveDesktopViewerUrl({
      rawUrl: "https://desktop.example/session?token=one",
      appUrl: "http://127.0.0.1:18799/",
      botId: "bot-a",
      transport: "hosted",
    })).toBe("https://desktop.example/session?token=one");
    expect(() => resolveDesktopViewerUrl({
      rawUrl: "http://desktop.example/session",
      appUrl: "http://127.0.0.1:18799/",
      botId: "bot-a",
      transport: "hosted",
    })).toThrow(/HTTPS/);
  });

  it.each(["javascript:opener.fetch('/api/config')", "data:text/html,owned", "file:///tmp/owned"]) (
    "rejects privileged browser scheme %s",
    (rawUrl) => {
      expect(() => resolveDesktopViewerUrl({
        rawUrl,
        appUrl: "http://127.0.0.1:18799/",
        botId: "bot-a",
        transport: "hosted",
      })).toThrow();
    },
  );

  it("rejects a cross-origin or wrong-bot noVNC path", () => {
    for (const rawUrl of [
      `https://evil.example${path}`,
      path.replace("/bots/bot-a/", "/bots/bot-b/"),
      `/api/bots/bot-a/local-computer/viewer/short/vnc.html`,
    ]) {
      expect(() => resolveDesktopViewerUrl({
        rawUrl,
        appUrl: "http://127.0.0.1:18799/",
        botId: "bot-a",
        transport: "proxied",
      })).toThrow();
    }
  });
});
