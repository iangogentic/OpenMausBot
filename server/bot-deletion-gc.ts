import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";

export type BotDeletionPhase = "prepared" | "provider" | "checkpoints" | "vm" | "workspace" | "logs";

export interface BotDeletionRecord {
  version: 1;
  botId: string;
  threadIds: string[];
  phase: BotDeletionPhase;
}

export interface BotDeletionCleanup {
  logicalDelete(botId: string): void | Promise<void>;
  provider(botId: string): void | Promise<void>;
  checkpoints(botId: string): void | Promise<void>;
  vm(botId: string): void | Promise<void>;
  workspace(botId: string): void | Promise<void>;
  logs(threadIds: string[]): void | Promise<void>;
}

const BOT_ID = /^[\w-]{1,128}$/;
const THREAD_ID = /^[\w-]{1,128}$/;

function validRecord(value: unknown): value is BotDeletionRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.botId === "string"
    && BOT_ID.test(record.botId)
    && Array.isArray(record.threadIds)
    && record.threadIds.length >= 1
    && record.threadIds.length <= 1_024
    && record.threadIds.every((id) => typeof id === "string" && THREAD_ID.test(id))
    && new Set(record.threadIds).size === record.threadIds.length
    && ["prepared", "provider", "checkpoints", "vm", "workspace", "logs"].includes(String(record.phase));
}

export class BotDeletionJournal {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    const expectedUid = process.getuid?.();
    if (
      !info.isDirectory()
      || info.isSymbolicLink()
      || (info.mode & 0o777) !== 0o700
      || (expectedUid !== undefined && info.uid !== expectedUid)
    ) {
      throw new Error("bot deletion journal directory is unsafe");
    }
  }

  private path(botId: string): string {
    if (!BOT_ID.test(botId)) throw new Error("invalid bot deletion identity");
    return join(this.directory, `${botId}.json`);
  }

  private syncDirectory(): void {
    const fd = openSync(this.directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }

  save(record: BotDeletionRecord): void {
    if (!validRecord(record)) throw new Error("invalid bot deletion journal record");
    writeFileAtomic(this.path(record.botId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    this.syncDirectory();
  }

  begin(botId: string, threadIds: string[]): BotDeletionRecord {
    const record: BotDeletionRecord = {
      version: 1,
      botId,
      threadIds: [...new Set(threadIds)],
      phase: "prepared",
    };
    this.save(record);
    return record;
  }

  pending(): BotDeletionRecord[] {
    const records: BotDeletionRecord[] = [];
    let removedTemporary = false;
    for (const name of readdirSync(this.directory).sort()) {
      if (/^[\w-]{1,128}\.json\.\d+\.[0-9a-f-]{36}\.tmp$/.test(name)) {
        const temporary = join(this.directory, name);
        const info = lstatSync(temporary);
        const expectedUid = process.getuid?.();
        if (
          !info.isFile()
          || info.isSymbolicLink()
          || info.nlink !== 1
          || (info.mode & 0o777) !== 0o600
          || (expectedUid !== undefined && info.uid !== expectedUid)
        ) throw new Error("bot deletion journal temporary record is unsafe");
        unlinkSync(temporary);
        removedTemporary = true;
        continue;
      }
      if (!/^[\w-]{1,128}\.json$/.test(name)) {
        throw new Error("bot deletion journal contains an unexpected entry");
      }
      const path = join(this.directory, name);
      const info = lstatSync(path);
      const expectedUid = process.getuid?.();
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 256 * 1024
        || (expectedUid !== undefined && info.uid !== expectedUid)) {
        throw new Error("bot deletion journal record is unsafe");
      }
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!validRecord(parsed) || `${parsed.botId}.json` !== name) {
        throw new Error("bot deletion journal record is invalid");
      }
      records.push(parsed);
    }
    if (removedTemporary) this.syncDirectory();
    return records;
  }

  finish(botId: string): void {
    try { unlinkSync(this.path(botId)); } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.syncDirectory();
  }
}

const NEXT: Record<BotDeletionPhase, BotDeletionPhase | null> = {
  prepared: "provider",
  provider: "checkpoints",
  checkpoints: "vm",
  vm: "workspace",
  workspace: "logs",
  logs: null,
};

/** Resume-safe cleanup. Each phase is idempotent and its durable transition is
 * recorded only after success, so a crash repeats cleanup instead of
 * resurrecting a logically deleted bot or silently skipping private state. */
export async function runBotDeletionGc(
  journal: BotDeletionJournal,
  initial: BotDeletionRecord,
  cleanup: BotDeletionCleanup,
): Promise<void> {
  let record = initial;
  while (true) {
    switch (record.phase) {
      case "prepared": await cleanup.logicalDelete(record.botId); break;
      case "provider": await cleanup.provider(record.botId); break;
      case "checkpoints": await cleanup.checkpoints(record.botId); break;
      case "vm": await cleanup.vm(record.botId); break;
      case "workspace": await cleanup.workspace(record.botId); break;
      case "logs": await cleanup.logs(record.threadIds); break;
    }
    const next = NEXT[record.phase];
    if (!next) {
      journal.finish(record.botId);
      return;
    }
    record = { ...record, phase: next };
    journal.save(record);
  }
}
