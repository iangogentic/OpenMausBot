// Image attachments: pasted/dropped images become files under
// ~/.openmausbot/attachments so every CLI engine can open them by path —
// the app never ships image bytes through the prompt itself.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { DATA_DIR } from "./config.ts";
import { WORKSPACES_DIR } from "./workspace.ts";

export const ATTACHMENTS_DIR = join(DATA_DIR, "attachments");
/** Non-image files selected on a remote controller live on the harness, not
 * on the controller's disk. They deliberately have a separate directory so
 * image rendering can remain a much narrower allowlist. */
export const UPLOADED_FILES_DIR = join(DATA_DIR, "uploaded-files");

/** The spec's ceiling: a screenshot bigger than this is rejected before it
 * is ever buffered, matching the composer's existing size discipline. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** A remote file transfer is intentionally bounded even when the controller
 * has a larger local file. This protects the harness disk and the Electron
 * shell from unbounded buffering on either side. */
export const FILE_MAX_BYTES = 25 * 1024 * 1024;
/** ext4/APFS filename components are capped at 255 bytes. Stored uploads add
 * a 36-byte UUID plus one dash, leaving this many UTF-8 bytes for metadata. */
export const UPLOAD_DISPLAY_NAME_MAX_BYTES = 218;

export type SafeViewerKind = "pdf" | "xlsx";

/** Parser routing is based on both the inert filename and file signature,
 * never an attacker-controlled Content-Type header. ZIP is only a candidate
 * XLSX here; the renderer additionally validates its central directory and a
 * bounded display-only OOXML parser runs in a disposable worker. */
export function safeViewerKind(name: string, bytes: Uint8Array): SafeViewerKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pdf") && bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) {
    return "pdf";
  }
  if (
    lower.endsWith(".xlsx") &&
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
  ) {
    return "xlsx";
  }
  return null;
}

/** Mimes the endpoint accepts, mapped to the extension stored on disk.
 * Sniffing is not attempted — a lie here only changes the filename. */
const IMAGE_MIMES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function extensionForMime(mime: string | undefined): string | null {
  if (!mime) return null;
  return IMAGE_MIMES[mime.split(";")[0]!.trim().toLowerCase()] ?? null;
}

export function ensureAttachmentsDir(): void {
  mkdirSync(ATTACHMENTS_DIR, { recursive: true, mode: 0o700 });
}

function ensureUploadedFilesDir(): void {
  mkdirSync(UPLOADED_FILES_DIR, { recursive: true, mode: 0o700 });
}

export interface SavedAttachment {
  path: string;
  mime: string;
  bytes: number;
}

/** Persist one image and return its path. The UUID filename means the name
 * is never attacker-controlled and never collides; the extension preserves
 * the format the sender claimed. */
export function saveImage(bytes: Buffer, mime: string): SavedAttachment {
  const ext = extensionForMime(mime);
  if (!ext) throw Object.assign(new Error("unsupported image type"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty image"), { status: 400 });
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    throw Object.assign(new Error(`image exceeds ${IMAGE_MAX_BYTES} bytes`), { status: 413 });
  }
  ensureAttachmentsDir();
  const name = `${randomUUID()}${ext}`;
  const path = join(ATTACHMENTS_DIR, name);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { path, mime: mime.split(";")[0]!.trim().toLowerCase(), bytes: bytes.byteLength };
}

export interface SavedFile {
  attachmentId: string;
  path: string;
  name: string;
  bytes: number;
}

/** A display name is metadata only. Keep it short and one-segment so it can
 * never become a server path or a response-header injection. */
export function safeUploadName(value: string): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (/[\\/]/.test(name)) return null;
  if (
    !name ||
    name.length > 180 ||
    Buffer.byteLength(name, "utf8") > UPLOAD_DISPLAY_NAME_MAX_BYTES ||
    /[\0-\x1f\x7f]/.test(name) ||
    name === "." ||
    name === ".."
  ) return null;
  return name;
}

/** Decode UTF-8 metadata carried in an ASCII-only HTTP header. Requiring a
 * canonical base64url spelling rejects ambiguous/truncated input, and the
 * byte round-trip rejects invalid UTF-8 instead of silently inserting U+FFFD. */
export function uploadNameFromHeader(value: string | undefined): string | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,1368}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.length > 1024 || bytes.toString("base64url") !== value) return null;
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return null;
  return safeUploadName(decoded);
}

/** Persist a non-image attachment selected by a remote controller. The UUID
 * is the actual storage name; the original name is retained only for the UI
 * and download dialog. */
export function saveUploadedFile(bytes: Buffer, displayName: string, threadId?: string): SavedFile {
  const name = safeUploadName(displayName);
  if (!name) throw Object.assign(new Error("file name is invalid"), { status: 400 });
  if (bytes.byteLength === 0) throw Object.assign(new Error("empty files cannot be attached"), { status: 400 });
  if (bytes.byteLength > FILE_MAX_BYTES) {
    throw Object.assign(new Error(`file exceeds ${FILE_MAX_BYTES} bytes`), { status: 413 });
  }
  ensureUploadedFilesDir();
  if (threadId !== undefined && !/^[\w-]{1,128}$/.test(threadId)) {
    throw Object.assign(new Error("conversation id is invalid"), { status: 400 });
  }
  const attachmentId = randomUUID();
  const directory = threadId ? join(UPLOADED_FILES_DIR, threadId) : UPLOADED_FILES_DIR;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storedName = `${attachmentId}-${name}`;
  const path = join(directory, storedName);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
  return { attachmentId, path, name, bytes: bytes.byteLength };
}

function containedBy(root: string, target: string): boolean {
  return target.startsWith(root + sep);
}

/**
 * Read a bot-created or server-managed file for a remote save action.
 *
 * The source path is untrusted model text. Only a canonical file inside a
 * bot workspace, image attachment store, or generic uploaded-file store is
 * eligible. We open the exact inode with O_NOFOLLOW and compare it to the
 * pre-open inode before reading, so a symlink/rename race cannot turn this
 * route into a general server file reader.
 */
export function readSavableServerFile(rawPath: string): { bytes: Buffer; name: string } | null {
  if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) return null;
  let requested: string;
  let target: string;
  let roots: string[];
  try {
    requested = resolve(rawPath);
    // Uploaded user attachments are intentionally excluded: renderer preview
    // must resolve those through readConversationUploadedFile with an opaque
    // conversation-scoped id, never a model/user-authored filesystem path.
    roots = [WORKSPACES_DIR, ATTACHMENTS_DIR].flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });
    target = realpathSync(requested);
  } catch {
    return null;
  }
  if (!roots.some((root) => containedBy(root, target))) return null;

  let fd: number | undefined;
  try {
    const before = statSync(target, { bigint: true });
    if (!before.isFile() || before.size > BigInt(FILE_MAX_BYTES)) return null;
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) return null;
    // Re-check the model-provided pathname after opening. A parent-directory
    // swap before open is caught here; a swap after this point cannot change
    // the already-open descriptor.
    if (realpathSync(requested) !== target) return null;
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, bytes, offset, size - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    return { bytes, name: basename(target) };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Resolve one app-issued upload capability inside one exact conversation.
 * The caller never supplies a filesystem path or display name. */
export function readConversationUploadedFile(
  threadId: string,
  attachmentId: string,
): { bytes: Buffer; name: string; path: string } | null {
  if (!/^[\w-]{1,128}$/.test(threadId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attachmentId)) return null;
  let directory: string;
  let names: string[];
  try {
    directory = realpathSync(join(UPLOADED_FILES_DIR, threadId));
    if (!containedBy(realpathSync(UPLOADED_FILES_DIR), directory)) return null;
    names = readdirSync(directory).filter((name) => name.startsWith(`${attachmentId}-`));
  } catch {
    return null;
  }
  if (names.length !== 1) return null;
  const path = join(directory, names[0]!);
  let fd: number | undefined;
  try {
    const linkInfo = lstatSync(path, { bigint: true });
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) return null;
    const target = realpathSync(path);
    if (!containedBy(directory, target)) return null;
    const before = statSync(target, { bigint: true });
    if (!before.isFile() || before.size > BigInt(FILE_MAX_BYTES) || before.ino !== linkInfo.ino || before.dev !== linkInfo.dev) return null;
    fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.size !== before.size || opened.ino !== before.ino || opened.dev !== before.dev) return null;
    if (realpathSync(path) !== target) return null;
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, bytes, offset, size - offset, offset);
      if (count <= 0) return null;
      offset += count;
    }
    return { bytes, name: names[0]!.slice(attachmentId.length + 1), path: target };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}


/** Existence check with the same name discipline as readAttachment, without
 * reading up to 10MB of pixels just to learn the file is there. */
export function attachmentExists(name: string): boolean {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|gif|webp)$/.test(name)) return false;
  try {
    return statSync(join(ATTACHMENTS_DIR, name)).isFile();
  } catch {
    return false;
  }
}

/** Read an attachment back for serving. Only names that are exactly a bare
 * filename (no separators, no dotfiles) inside ATTACHMENTS_DIR resolve —
 * the route must never become a general file server for the data dir. */
export function readAttachment(name: string): { bytes: Buffer; mime: string } | null {
  if (!/^[A-Za-z0-9-]+\.(png|jpg|jpeg|gif|webp)$/.test(name)) return null;
  const path = join(ATTACHMENTS_DIR, name);
  if (extname(path) === ".jpeg") return null; // saved as .jpg; .jpeg is not a name we write
  try {
    return { bytes: readFileSync(path), mime: mimeForExt(extname(path)) };
  } catch {
    return null;
  }
}

function mimeForExt(ext: string): string {
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}
