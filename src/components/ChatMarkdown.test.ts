import { createServer } from "node:http";
import { describe, expect, it } from "vitest";

import { explicitImageLink, safeBotImageSrc } from "./ChatMarkdown";

describe("bot markdown image policy", () => {
  it("allows only same-origin raster assets or bounded non-scriptable data", () => {
    expect(safeBotImageSrc("/api/attachments/a.png", "https://razer.example")).toBe(
      "https://razer.example/api/attachments/a.png",
    );
    expect(safeBotImageSrc("data:image/png;base64,AA==", "https://razer.example")).toBe("data:image/png;base64,AA==");
    expect(safeBotImageSrc("data:image/svg+xml;base64,PHN2Zz4=", "https://razer.example")).toBeNull();
    expect(safeBotImageSrc("https://tracker.example/pixel.png", "https://razer.example")).toBeNull();
    expect(safeBotImageSrc("file:///etc/passwd", "https://razer.example")).toBeNull();
  });

  it("does not contact a controller-local HTTP canary for bot image markdown", async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      res.end("canary");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("canary did not listen");
      const canary = `http://127.0.0.1:${address.port}/private.png`;
      // The renderer receives null and renders only an explicit external-link
      // control. Crucially this utility does not create an Image or fetch.
      expect(safeBotImageSrc(canary, "https://razer.example")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(hits).toBe(0);
      expect(explicitImageLink(canary)).toBe(canary);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
