import { describe, expect, it } from "vitest";

import { validBoxDesktopUrl } from "./box.ts";

describe("Box desktop URL trust boundary", () => {
  it("accepts only HTTPS ascii.dev origins without URL userinfo", () => {
    expect(validBoxDesktopUrl("https://ascii.dev/view/token?q=1#screen")).toBe(
      "https://ascii.dev/view/token?q=1#screen",
    );
    expect(validBoxDesktopUrl("https://desktop.ascii.dev/vnc?token=fresh")).toBe(
      "https://desktop.ascii.dev/vnc?token=fresh",
    );

    for (const value of [
      "http://desktop.ascii.dev/vnc",
      "https://ascii.dev.evil.example/vnc",
      "https://notascii.dev/vnc",
      "https://user:secret@desktop.ascii.dev/vnc",
      "https://@desktop.ascii.dev/vnc",
      "javascript:alert(1)",
      "not a URL",
      `https://desktop.ascii.dev/${"x".repeat(4_096)}`,
      null,
      { url: "https://desktop.ascii.dev/vnc" },
    ]) expect(validBoxDesktopUrl(value)).toBeNull();
  });

  it("normalizes hostname case without weakening the suffix boundary", () => {
    expect(validBoxDesktopUrl("https://DESKTOP.ASCII.DEV/vnc")).toBe("https://desktop.ascii.dev/vnc");
    expect(validBoxDesktopUrl("https://evil-ascii.dev/vnc")).toBeNull();
  });
});
