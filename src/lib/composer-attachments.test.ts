// composeMessage with images, the image tag round-trip through
// splitAttachedImages, and the mime gate the composer pastes through.
import { describe, expect, it } from "vitest";

import {
  appendPastedText,
  attachmentBasename,
  attachmentImageUrl,
  composeMessage,
  isImageFile,
  splitAttachedImages,
  splitTranscriptAttachments,
  replaceTranscriptDisplayText,
  uploadFileNameHeader,
  type ImageAttachment,
} from "./composer-attachments";

/** Exercises the spacing and empty-draft cases for pasted text insertion. */
function appendPastedTextTests() {
  /** Keeps an existing draft ahead of newly inserted pasted content. */
  function addsPastedContentAfterDraft() {
    expect(appendPastedText("Keep this", "Edit this too")).toBe("Keep this\n\nEdit this too");
  }

  /** Avoids duplicating a separator when the draft already ends with a newline. */
  function preservesExistingTrailingNewline() {
    expect(appendPastedText("Keep this\n", "Edit this too")).toBe("Keep this\nEdit this too");
  }

  /** Inserts pasted content directly when no draft exists yet. */
  function insertsIntoEmptyDraft() {
    expect(appendPastedText("", "Edit this too")).toBe("Edit this too");
  }

  it("adds pasted content after an existing draft", addsPastedContentAfterDraft);
  it("does not add a second separator when the draft ends with a newline", preservesExistingTrailingNewline);
  it("uses the pasted content directly for an empty draft", insertsIntoEmptyDraft);
}

describe("appendPastedText", appendPastedTextTests);

/** Builds a stable image attachment fixture for prompt and preview tests. */
function image(path: string): ImageAttachment {
  return {
    kind: "image",
    id: "i1",
    path,
    name: "shot.png",
    size: 1234,
    mime: "image/png",
  };
}

describe("composeMessage with images", () => {
  it("emits an attached-image tag carrying the server path", () => {
    const prompt = composeMessage("what is this?", [image("/home/u/.openmausbot/attachments/abc.png")]);
    expect(prompt).toBe(
      'what is this?\n\n<attached-image path="/home/u/.openmausbot/attachments/abc.png" />',
    );
  });

  it("escapes a hostile path the same way file paths are escaped", () => {
    const prompt = composeMessage("", [image('/x/")} onload="evil()')]);
    // every quote is entity-encoded, so the payload can never break out of
    // the attribute — the tag stays one well-formed element
    expect(prompt).toMatch(/<attached-image path="[^"]*" \/>/);
    expect(prompt).toContain("&quot;");
  });
});

describe("splitAttachedImages", () => {
  it("splits tags out of a stored message and returns the paths", () => {
    const stored =
      'look at this\n\n<attached-image path="/a/b/one.png" />\n\n<attached-image path="/a/b/two.jpg" />';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe("look at this");
    expect(images).toEqual(["/a/b/one.png", "/a/b/two.jpg"]);
  });

  it("unescapes attribute entities so the path round-trips", () => {
    const stored = '<attached-image path="/a/b/&amp;x.png" />';
    const { images } = splitAttachedImages(stored);
    expect(images).toEqual(["/a/b/&x.png"]);
  });

  it("leaves plain text and other tags untouched", () => {
    const stored = '<pasted-text index="1">\nhi\n</pasted-text>';
    const { display, images } = splitAttachedImages(stored);
    expect(display).toBe(stored);
    expect(images).toEqual([]);
  });
});

describe("splitTranscriptAttachments", () => {
  it("extracts safe file chips and hides all full paths from display text", () => {
    const stored = 'Review these\n<attached-file path="/private/server/123e4567-e89b-12d3-a456-426614174000-report.pdf" attachment-id="123e4567-e89b-42d3-a456-426614174000" />\n<attached-file path="C:\\secret\\budget.xlsx" />';
    const result = splitTranscriptAttachments(stored);
    expect(result.display).toBe("Review these");
    expect(result.files).toEqual([
      { path: "/private/server/123e4567-e89b-12d3-a456-426614174000-report.pdf", attachmentId: "123e4567-e89b-42d3-a456-426614174000", name: "report.pdf", preview: "pdf" },
      { path: "C:\\secret\\budget.xlsx", name: "budget.xlsx", preview: "xlsx" },
    ]);
    expect(result.display).not.toContain("123e4567-e89b-42d3-a456-426614174000");
  });

  it("keeps unsupported attachments as inert filename-only chips", () => {
    expect(splitTranscriptAttachments('<attached-file path="/secret/archive.zip" />').files).toEqual([
      { path: "/secret/archive.zip", name: "archive.zip", preview: null },
    ]);
  });

  it("preserves hidden attachment tags when visible message text is edited", () => {
    const original = 'old\n\n<attached-file path="/secret/report.pdf" attachment-id="123e4567-e89b-42d3-a456-426614174000" />';
    expect(replaceTranscriptDisplayText(original, "new")).toBe('new\n\n<attached-file path="/secret/report.pdf" attachment-id="123e4567-e89b-42d3-a456-426614174000" />');
  });
});

describe("attachmentBasename", () => {
  it("takes the final path segment on POSIX and Windows separators", () => {
    expect(attachmentBasename("/a/b/c.png")).toBe("c.png");
    expect(attachmentBasename("C:\\a\\b\\c.png")).toBe("c.png");
  });

  it("turns only generated image names into same-origin preview URLs", () => {
    expect(attachmentImageUrl("/a/b/123e4567-e89b-12d3-a456-426614174000.png")).toBe(
      "/api/attachments/123e4567-e89b-12d3-a456-426614174000.png",
    );
    expect(attachmentImageUrl("C:\\a\\b\\photo.webp")).toBe("/api/attachments/photo.webp");
    expect(attachmentImageUrl("https://attacker.example/tracker.png?cookie=1")).toBeNull();
    expect(attachmentImageUrl("/a/b/payload.svg")).toBeNull();
    expect(attachmentImageUrl("/a/b/not%2Fan-image.png")).toBeNull();
  });
});

describe("isImageFile", () => {
  it("accepts the served image mimes and rejects others", () => {
    expect(isImageFile({ type: "image/png", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/jpeg", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/webp", size: 10 })).toBe(true);
    expect(isImageFile({ type: "image/svg+xml", size: 10 })).toBe(false);
    expect(isImageFile({ type: "text/plain", size: 10 })).toBe(false);
  });
});

describe("remote file-name metadata", () => {
  it("encodes emoji and CJK Finder names as ASCII-only UTF-8 base64url", () => {
    const encoded = uploadFileNameHeader("📄-报告.txt");
    expect(encoded).toBe("8J-ThC3miqXlkYoudHh0");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
