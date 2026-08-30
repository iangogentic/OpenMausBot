// Exact-turn handoff for app-managed attachments.
//
// Uploads live under DATA_DIR, which is intentionally absent from the
// provider bwrap.  Before a local provider starts, copy only the files named
// by canonical composer tags into one unpredictable provider-runtime
// directory, rewrite those tags to the staged paths, and mount that one
// directory read-only for that one turn.  The provider never receives the
// attachment store, another bot's handoff, or any server configuration.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import {
  ATTACHMENTS_DIR,
  FILE_MAX_BYTES,
  IMAGE_MAX_BYTES,
  UPLOADED_FILES_DIR,
  safeUploadName,
} from "./attachments.ts";
import { createProviderTempDirectory } from "./provider-runtime.ts";

export const TURN_ATTACHMENT_MAX_REFERENCES = 32;
export const TURN_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

type AttachmentKind = "image" | "file";

export interface TurnAttachmentRuntimePath {
  path: string;
  writable?: boolean;
}

export interface StagedTurnAttachment {
  kind: AttachmentKind;
  sourcePath: string;
  stagedPath: string;
  bytes: number;
}

export interface StagedTurnAttachments {
  /** Texts in the same order supplied by the caller. */
  texts: string[];
  /** Exactly one read-only directory when managed files were present. */
  providerRuntimePaths: TurnAttachmentRuntimePath[];
  staged: StagedTurnAttachment[];
  totalBytes: number;
  /** Idempotent; removes only this unpredictable exact-turn directory. */
  cleanup(): void;
}

interface OpenedManagedFile {
  fd: number;
  kind: AttachmentKind;
  sourcePath: string;
  displayName: string;
  size: number;
  dev: bigint;
  ino: bigint;
}

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
const IMAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/i;
const TAG = /<attached-(image|file)\s+path="([^"]*)"(?:\s+attachment-id="([^"]*)")?\s*\/?>/g;

function attachmentError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

function unescapeAttribute(value: string): string {
  return value.replace(/&(quot|lt|gt|amp|#9|#13|#10);/g, (match, entity: string) => {
    switch (entity) {
      case "quot": return '"';
      case "lt": return "<";
      case "gt": return ">";
      case "amp": return "&";
      case "#9": return "\t";
      case "#13": return "\r";
      case "#10": return "\n";
      default: return match;
    }
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");
}

function managedRootForPath(rawPath: string): { kind: AttachmentKind; root: string } | null {
  if (!isAbsolute(rawPath) || rawPath.length > 4096 || rawPath.includes("\0")) return null;
  const parent = dirname(resolve(rawPath));
  if (parent === resolve(ATTACHMENTS_DIR)) return { kind: "image", root: ATTACHMENTS_DIR };
  if (parent === resolve(UPLOADED_FILES_DIR) || dirname(parent) === resolve(UPLOADED_FILES_DIR)) return { kind: "file", root: UPLOADED_FILES_DIR };
  return null;
}

/** A running provider's bwrap mount table is immutable. Managed attachments
 * arriving as a mid-turn steer must therefore queue for the next provider
 * process instead of receiving an inaccessible DATA_DIR path. */
export function hasManagedAttachmentReferences(text: string): boolean {
  if (typeof text !== "string") return false;
  for (const match of text.matchAll(TAG)) {
    if (managedRootForPath(unescapeAttribute(match[2] ?? ""))) return true;
  }
  return false;
}

function validatedDisplayName(kind: AttachmentKind, sourcePath: string): string | null {
  const name = basename(sourcePath);
  if (kind === "image") return IMAGE_NAME.test(name) ? name : null;
  const prefix = name.match(UUID_PREFIX)?.[0];
  if (!prefix || name[prefix.length] !== "-") return null;
  const displayName = name.slice(prefix.length + 1);
  return safeUploadName(displayName) ? displayName : null;
}

/** Inode equality is kept as one explicit predicate so both pre-open and
 * post-read pathname swaps are fail-closed. */
export function sameRegularInode(
  expected: { isFile(): boolean; dev: bigint | number; ino: bigint | number; size: bigint | number },
  opened: { isFile(): boolean; dev: bigint | number; ino: bigint | number; size: bigint | number },
): boolean {
  return Boolean(
    expected.isFile() &&
    opened.isFile() &&
    BigInt(expected.dev) === BigInt(opened.dev) &&
    BigInt(expected.ino) === BigInt(opened.ino) &&
    BigInt(expected.size) === BigInt(opened.size)
  );
}

function openManagedFile(rawPath: string, tagKind: AttachmentKind): OpenedManagedFile | null {
  const managed = managedRootForPath(rawPath);
  if (!managed) return null;
  if (managed.kind !== tagKind) throw attachmentError(`attached ${tagKind} has the wrong managed-file type`);

  const sourcePath = resolve(rawPath);
  const displayName = validatedDisplayName(tagKind, sourcePath);
  if (!displayName) throw attachmentError("managed attachment name is invalid");

  let fd: number | undefined;
  try {
    const rootInfo = lstatSync(managed.root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe managed root");
    // realpath(parent) must be the exact managed root. No nested directories,
    // alternate store, or symlinked parent can widen the source authority.
    const realParent = realpathSync(dirname(sourcePath));
    const realRoot = realpathSync(managed.root);
    if (realParent !== realRoot && dirname(realParent) !== realRoot) throw new Error("wrong managed root");
    const before = lstatSync(sourcePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not a regular managed file");
    fd = openSync(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    if (!sameRegularInode(before, opened)) throw new Error("managed attachment changed before open");
    const limit = tagKind === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
    if (opened.size <= 0n) throw attachmentError("managed attachment is empty");
    if (opened.size > BigInt(limit)) throw attachmentError(`managed attachment exceeds ${limit} bytes`, 413);
    return {
      fd,
      kind: tagKind,
      sourcePath,
      displayName,
      size: Number(opened.size),
      dev: opened.dev,
      ino: opened.ino,
    };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if ((error as { status?: unknown }).status) throw error;
    throw attachmentError("managed attachment is missing or unsafe");
  }
}

function readExactManagedBytes(opened: OpenedManagedFile): Buffer {
  try {
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(opened.fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw attachmentError("managed attachment changed while reading");
      offset += count;
    }
    // A rename/symlink swap cannot alter the already-open descriptor, but it
    // must still invalidate this pathname handoff. This prevents a prompt
    // from claiming it staged the current file when it actually staged an
    // inode that was raced out from under that name.
    const after = lstatSync(opened.sourcePath, { bigint: true });
    const descriptor = fstatSync(opened.fd, { bigint: true });
    if (after.isSymbolicLink() || !sameRegularInode(after, descriptor)) {
      throw attachmentError("managed attachment changed while staging");
    }
    return bytes;
  } catch (error) {
    if ((error as { status?: unknown }).status) throw error;
    throw attachmentError("managed attachment changed while staging");
  } finally {
    closeSync(opened.fd);
  }
}

function writeExactFile(path: string, bytes: Buffer, sharedAcrossUid: boolean): void {
  const mode = sharedAcrossUid ? 0o640 : 0o600;
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    mode,
  );
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = writeSync(fd, bytes, offset, bytes.byteLength - offset, offset);
      if (count <= 0) throw new Error("could not stage complete attachment bytes");
      offset += count;
    }
    const written = fstatSync(fd);
    if (!written.isFile() || written.size !== bytes.byteLength) {
      throw new Error("staged attachment size did not match source");
    }
    chmodSync(path, mode);
  } finally {
    closeSync(fd);
  }
}

function stagedName(kind: AttachmentKind, displayName: string, index: number): string {
  if (kind === "image") return `${String(index).padStart(2, "0")}-${randomUUID()}${extname(displayName).toLowerCase()}`;
  return `${String(index).padStart(2, "0")}-${randomUUID()}-${displayName}`;
}

/**
 * Stage every app-managed attachment tag present in `texts`.
 *
 * Paths outside the two managed stores are intentionally left unchanged:
 * they may already name a file inside the bot's mounted project workspace.
 * A path inside a managed store is never left behind on validation failure.
 */
export function stageTurnAttachments(texts: readonly string[], threadId?: string): StagedTurnAttachments {
  if (texts.length > 64) throw attachmentError("too many turn text segments");
  let runtime: ReturnType<typeof createProviderTempDirectory> | null = null;
  let cleaned = false;
  const stagedBySource = new Map<string, StagedTurnAttachment>();
  const staged: StagedTurnAttachment[] = [];
  let totalBytes = 0;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (runtime) rmSync(runtime.path, { recursive: true, force: true });
  };

  try {
    const rewritten = texts.map((text) => {
      if (typeof text !== "string") throw attachmentError("turn text must be a string");
      return text.replace(TAG, (_whole, rawKind: string, rawAttribute: string, rawAttachmentId?: string) => {
        const kind = rawKind as AttachmentKind;
        const sourcePath = unescapeAttribute(rawAttribute);
        const managed = managedRootForPath(sourcePath);
        if (!managed) return _whole;
        if (kind === "file" && threadId) {
          const attachmentId = rawAttachmentId ? unescapeAttribute(rawAttachmentId) : "";
          const expectedParent = resolve(join(UPLOADED_FILES_DIR, threadId));
          if (!/^[0-9a-f-]{36}$/i.test(attachmentId) || dirname(resolve(sourcePath)) !== expectedParent || !basename(sourcePath).startsWith(`${attachmentId}-`)) {
            throw attachmentError("managed attachment does not belong to this conversation");
          }
        }

        const key = `${kind}\0${resolve(sourcePath)}`;
        let handoff = stagedBySource.get(key);
        if (!handoff) {
          if (staged.length >= TURN_ATTACHMENT_MAX_REFERENCES) {
            throw attachmentError(`a turn may reference at most ${TURN_ATTACHMENT_MAX_REFERENCES} managed attachments`, 413);
          }
          const opened = openManagedFile(sourcePath, kind);
          if (!opened) return _whole;
          if (opened.size > TURN_ATTACHMENT_MAX_TOTAL_BYTES - totalBytes) {
            closeSync(opened.fd);
            throw attachmentError(
              `turn attachments exceed ${TURN_ATTACHMENT_MAX_TOTAL_BYTES} bytes in total`,
              413,
            );
          }
          const bytes = readExactManagedBytes(opened);
          runtime ??= createProviderTempDirectory("attachments-");
          const stagedPath = resolve(runtime.path, stagedName(kind, opened.displayName, staged.length + 1));
          if (dirname(stagedPath) !== resolve(runtime.path)) throw attachmentError("staged attachment path escaped its turn");
          writeExactFile(stagedPath, bytes, runtime.sharedAcrossUid);
          handoff = { kind, sourcePath: opened.sourcePath, stagedPath, bytes: bytes.byteLength };
          stagedBySource.set(key, handoff);
          staged.push(handoff);
          totalBytes += bytes.byteLength;
        }
        return `<attached-${kind} path="${escapeAttribute(handoff.stagedPath)}" />`;
      });
    });

    const runtimePath = staged[0] ? dirname(staged[0].stagedPath) : null;
    return {
      texts: rewritten,
      providerRuntimePaths: runtimePath ? [{ path: runtimePath }] : [],
      staged,
      totalBytes,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
