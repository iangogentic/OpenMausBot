// attachments.ts: save + read-back, the mime allowlist, size ceiling, and
// the name-lock that keeps the serving route inside the attachments dir.
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The module reads DATA_DIR at import time, so the env var must be set
// before the import is evaluated.
const DATA_ROOT = mkdtempSync(join(tmpdir(), "omb-attachments-"));
process.env.OMB_DATA_DIR = join(DATA_ROOT, "data");

const {
  ATTACHMENTS_DIR,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  UPLOADED_FILES_DIR,
  UPLOAD_DISPLAY_NAME_MAX_BYTES,
  extensionForMime,
  readAttachment,
  readConversationUploadedFile,
  readSavableServerFile,
  safeViewerKind,
  safeUploadName,
  saveImage,
  saveUploadedFile,
  uploadNameFromHeader,
} = await import("./attachments.ts");
const { WORKSPACES_DIR } = await import("./workspace.ts");

describe("extensionForMime", () => {
  it("maps the accepted image mimes to extensions", () => {
    expect(extensionForMime("image/png")).toBe(".png");
    expect(extensionForMime("image/jpeg")).toBe(".jpg");
    expect(extensionForMime("image/gif")).toBe(".gif");
    expect(extensionForMime("image/webp")).toBe(".webp");
  });

  it("tolerates parameters and casing", () => {
    expect(extensionForMime("Image/PNG; charset=binary")).toBe(".png");
    expect(extensionForMime("  image/webp  ")).toBe(".webp");
  });

  it("refuses everything else — including svg, which executes script", () => {
    expect(extensionForMime("image/svg+xml")).toBeNull();
    expect(extensionForMime("text/plain")).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe("safeViewerKind", () => {
  it("requires matching inert extensions and magic bytes", () => {
    expect(safeViewerKind("report.pdf", Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(safeViewerKind("report.pdf", Buffer.from("not-pdf"))).toBeNull();
    expect(safeViewerKind("sheet.xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("xlsx");
    expect(safeViewerKind("sheet.xlsm", Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
    expect(safeViewerKind("payload.html", Buffer.from("%PDF-1.7"))).toBeNull();
  });
});

describe("saveImage", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("persists bytes under the attachments dir with a generated name", () => {
    const saved = saveImage(Buffer.from("png-bytes"), "image/png");
    expect(saved.path.startsWith(ATTACHMENTS_DIR)).toBe(true);
    expect(saved.path.endsWith(".png")).toBe(true);
    expect(saved.bytes).toBe(9);
    expect(saved.mime).toBe("image/png");
    if (process.platform !== "win32") {
      expect(statSync(ATTACHMENTS_DIR).mode & 0o777).toBe(0o700);
      expect(statSync(saved.path).mode & 0o777).toBe(0o600);
    }
  });

  it("round-trips through readAttachment with the right mime", () => {
    const saved = saveImage(Buffer.from("gif!"), "image/gif");
    const name = saved.path.split(/[\\/]/).pop()!;
    const back = readAttachment(name);
    expect(back?.bytes.toString()).toBe("gif!");
    expect(back?.mime).toBe("image/gif");
  });

  it("rejects unsupported mimes, empty bodies, and oversize bodies", () => {
    expect(() => saveImage(Buffer.from("x"), "image/svg+xml")).toThrow(/unsupported image type/);
    expect(() => saveImage(Buffer.alloc(0), "image/png")).toThrow(/empty/);
    expect(() => saveImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/png")).toThrow(/exceeds/);
  });
});

describe("readAttachment name lock", () => {
  beforeEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  it("refuses traversal, dotfiles, and names the saver never writes", () => {
    expect(readAttachment("..%2F..%2Fconfig.json")).toBeNull();
    expect(readAttachment(".env")).toBeNull();
    expect(readAttachment("a/b.png")).toBeNull();
    expect(readAttachment("no-extension")).toBeNull();
    expect(readAttachment("uuid.jpeg")).toBeNull(); // saved as .jpg
  });
});

describe("remote server file transfer containment", () => {
  beforeEach(() => {
    rmSync(UPLOADED_FILES_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    rmSync(UPLOADED_FILES_DIR, { recursive: true, force: true });
    rmSync(WORKSPACES_DIR, { recursive: true, force: true });
  });

  it("stores a remote binary under the server and returns its exact bytes", () => {
    const payload = Buffer.from([0, 1, 2, 0xff]);
    const saved = saveUploadedFile(payload, "report.bin", "thread-a");
    expect(saved.path.startsWith(UPLOADED_FILES_DIR)).toBe(true);
    expect(readConversationUploadedFile("thread-a", saved.attachmentId)).toMatchObject({ bytes: payload });
    expect(readConversationUploadedFile("thread-b", saved.attachmentId)).toBeNull();
    expect(readSavableServerFile(saved.path)).toBeNull();
    expect(safeUploadName("../escape.bin")).toBeNull();
    expect(safeUploadName("bad\nname")).toBeNull();
  });

  it("refuses a scoped upload path replaced by a symlink", () => {
    const saved = saveUploadedFile(Buffer.from("original"), "private.txt", "thread-a");
    const outside = join(DATA_ROOT, "scoped-outside.txt");
    writeFileSync(outside, "replacement");
    rmSync(saved.path);
    symlinkSync(outside, saved.path);
    expect(readConversationUploadedFile("thread-a", saved.attachmentId)).toBeNull();
  });

  it("round-trips canonical UTF-8 filename metadata and rejects malformed encodings", () => {
    const name = "📄-报告.bin";
    expect(uploadNameFromHeader(Buffer.from(name, "utf8").toString("base64url"))).toBe(name);
    expect(uploadNameFromHeader("_w")).toBeNull(); // invalid UTF-8
    expect(uploadNameFromHeader(Buffer.from("../escape", "utf8").toString("base64url"))).toBeNull();
    expect(uploadNameFromHeader("not+base64")).toBeNull();
  });

  it("bounds upload display names by UTF-8 bytes before the filesystem write", () => {
    const within = "界".repeat(Math.floor(UPLOAD_DISPLAY_NAME_MAX_BYTES / 3));
    const over = `${within}界`;
    expect(Buffer.byteLength(within, "utf8")).toBeLessThanOrEqual(UPLOAD_DISPLAY_NAME_MAX_BYTES);
    expect(safeUploadName(within)).toBe(within);
    expect(safeUploadName(over)).toBeNull();
    expect(() => saveUploadedFile(Buffer.from("x"), over)).toThrow(/file name is invalid/);
  });

  it("allows a real bot workspace file but refuses symlink escapes and oversized content", () => {
    const bot = "bot-a";
    const workspace = join(WORKSPACES_DIR, bot);
    mkdirSync(workspace, { recursive: true });
    const report = join(workspace, "report.txt");
    writeFileSync(report, "razer-only bytes");
    expect(readSavableServerFile(report)?.bytes.toString()).toBe("razer-only bytes");

    const outside = join(DATA_ROOT, "outside.txt");
    writeFileSync(outside, "not exportable");
    symlinkSync(outside, join(workspace, "escape.txt"));
    expect(readSavableServerFile(join(workspace, "escape.txt"))).toBeNull();

    const oversized = join(workspace, "big.bin");
    writeFileSync(oversized, Buffer.alloc(FILE_MAX_BYTES + 1));
    expect(readSavableServerFile(oversized)).toBeNull();
  });
});
