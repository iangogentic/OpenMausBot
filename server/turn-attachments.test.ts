import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

// Both managed roots and the production-readable runtime boundary are fixed
// at module import time. Keep the fixture canonical (macOS /var is a symlink)
// and non-writable by group/other so providerRuntimeBase accepts it.
const TEST_ROOT = realpathSync(mkdtempSync(join(tmpdir(), "omb-turn-attachments-")));
const RUNTIME_ROOT = join(TEST_ROOT, "provider-runtime");
mkdirSync(RUNTIME_ROOT, { mode: 0o750 });
chmodSync(RUNTIME_ROOT, 0o750);
process.env.OMB_DATA_DIR = join(TEST_ROOT, "data");
process.env.OMB_PROVIDER_RUNTIME_DIR = RUNTIME_ROOT;

const {
  ATTACHMENTS_DIR,
  UPLOADED_FILES_DIR,
  saveImage,
  saveUploadedFile,
} = await import("./attachments.ts");
const {
  TURN_ATTACHMENT_MAX_REFERENCES,
  hasManagedAttachmentReferences,
  sameRegularInode,
  stageTurnAttachments,
} = await import("./turn-attachments.ts");

function clearFixtures(): void {
  rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
  rmSync(UPLOADED_FILES_DIR, { recursive: true, force: true });
  for (const child of readdirSync(RUNTIME_ROOT)) {
    rmSync(join(RUNTIME_ROOT, child), { recursive: true, force: true });
  }
}

beforeEach(clearFixtures);
afterEach(clearFixtures);
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe("exact-turn attachment handoff", () => {
  it("identifies managed tags that must queue instead of steering into an immutable sandbox", () => {
    const upload = saveUploadedFile(Buffer.from("queued"), "queued & safe.txt");
    expect(hasManagedAttachmentReferences(
      `<attached-file path="${upload.path.replaceAll("&", "&amp;")}" />`,
    )).toBe(true);
    expect(hasManagedAttachmentReferences('<attached-file path="/project/already-mounted.txt" />')).toBe(false);
  });

  it("copies exact binary image and file bytes, rewrites every reference, and deduplicates", () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]);
    const fileBytes = Buffer.from([0, 1, 2, 3, 0xfe, 0xff]);
    const image = saveImage(imageBytes, "image/png");
    const file = saveUploadedFile(fileBytes, "design & notes.bin");

    const handoff = stageTurnAttachments([
      `inspect\n\n<attached-image path="${image.path}" />\n\n<attached-file path="${file.path.replaceAll("&", "&amp;")}" />`,
      `history repeats <attached-file path="${file.path.replaceAll("&", "&amp;")}" />`,
    ]);

    expect(handoff.providerRuntimePaths).toEqual([{ path: expect.stringContaining("attachments-") }]);
    expect(handoff.staged).toHaveLength(2);
    expect(handoff.totalBytes).toBe(imageBytes.byteLength + fileBytes.byteLength);
    expect(readFileSync(handoff.staged.find((entry) => entry.kind === "image")!.stagedPath)).toEqual(imageBytes);
    expect(readFileSync(handoff.staged.find((entry) => entry.kind === "file")!.stagedPath)).toEqual(fileBytes);
    expect(handoff.texts.join("\n")).not.toContain(image.path);
    expect(handoff.texts.join("\n")).not.toContain(file.path);
    expect(handoff.texts[1]).toContain(handoff.staged.find((entry) => entry.kind === "file")!.stagedPath.replaceAll("&", "&amp;"));

    const turnDirectory = handoff.providerRuntimePaths[0]!.path;
    if (process.platform !== "win32") {
      expect(lstatSync(turnDirectory).mode & 0o7777).toBe(0o2750);
      for (const entry of handoff.staged) expect(lstatSync(entry.stagedPath).mode & 0o777).toBe(0o640);
    }
    handoff.cleanup();
    handoff.cleanup();
    expect(() => lstatSync(turnDirectory)).toThrow();
  });

  it("authorizes scoped uploads only for the exact conversation and attachment id", () => {
    const file = saveUploadedFile(Buffer.from("thread A only"), "private.txt", "thread-a");
    const tag = `<attached-file path="${file.path}" attachment-id="${file.attachmentId}" />`;

    const authorized = stageTurnAttachments([tag], "thread-a");
    expect(readFileSync(authorized.staged[0]!.stagedPath, "utf8")).toBe("thread A only");
    expect(authorized.texts[0]).not.toContain(file.attachmentId);
    authorized.cleanup();

    expect(() => stageTurnAttachments([tag], "thread-b")).toThrow(/does not belong/);
    expect(() => stageTurnAttachments([
      tag.replace(file.attachmentId, "00000000-0000-4000-8000-000000000000"),
    ], "thread-a")).toThrow(/does not belong/);
  });

  it("denies symlinked sources and a managed file tagged as the wrong type", () => {
    const outside = join(TEST_ROOT, "outside-secret.txt");
    writeFileSync(outside, "server secret");
    const upload = saveUploadedFile(Buffer.from("allowed bytes"), "safe.txt");
    rmSync(upload.path);
    symlinkSync(outside, upload.path);

    expect(() => stageTurnAttachments([`<attached-file path="${upload.path}" />`])).toThrow(/missing or unsafe/);

    const image = saveImage(Buffer.from("image"), "image/png");
    expect(() => stageTurnAttachments([`<attached-file path="${image.path}" />`])).toThrow(/wrong managed-file type/);
    expect(readdirSync(RUNTIME_ROOT)).toEqual([]);
  });

  it("detects the inode mismatch produced by a pathname replacement race", () => {
    const upload = saveUploadedFile(Buffer.from("original"), "race.bin");
    const before = lstatSync(upload.path, { bigint: true });
    const moved = join(TEST_ROOT, "old-race.bin");
    renameSync(upload.path, moved);
    writeFileSync(upload.path, "replacement", { mode: 0o600 });
    const replacement = lstatSync(upload.path, { bigint: true });

    expect(sameRegularInode(before, before)).toBe(true);
    expect(sameRegularInode(before, replacement)).toBe(false);
  });

  it("does not let another turn remount a guessed staged path", () => {
    const upload = saveUploadedFile(Buffer.from("bot A only"), "bot-a.txt");
    const botA = stageTurnAttachments([`<attached-file path="${upload.path}" />`]);
    const stagedPath = botA.staged[0]!.stagedPath;

    // A staged path is not itself a managed upload. A second turn gets no
    // runtime mount for it, even if its prompt somehow learns that path.
    const botB = stageTurnAttachments([`<attached-file path="${stagedPath}" />`]);
    expect(botB.providerRuntimePaths).toEqual([]);
    expect(botB.staged).toEqual([]);
    expect(botB.texts[0]).toContain(stagedPath);
    expect(botA.providerRuntimePaths[0]!.path).not.toBe(botB.providerRuntimePaths[0]?.path);

    botB.cleanup();
    botA.cleanup();
  });

  it("bounds reference count before allocating a handoff directory", () => {
    const uploads = Array.from(
      { length: TURN_ATTACHMENT_MAX_REFERENCES + 1 },
      (_, index) => saveUploadedFile(Buffer.from([index]), `managed-${index}.bin`),
    );
    const prompt = uploads.map((upload) => `<attached-file path="${upload.path}" />`).join("\n");
    expect(() => stageTurnAttachments([prompt])).toThrow(/at most .* attachments/);
    expect(readdirSync(RUNTIME_ROOT)).toEqual([]);
  });
});
