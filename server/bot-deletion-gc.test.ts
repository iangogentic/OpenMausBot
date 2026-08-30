import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotDeletionJournal, runBotDeletionGc, type BotDeletionCleanup } from "./bot-deletion-gc.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmaus-delete-gc-"));
  roots.push(root);
  return { root, journal: new BotDeletionJournal(join(root, "journal")) };
}

describe("durable bot deletion GC", () => {
  it.each(["logicalDelete", "provider", "checkpoints", "vm", "workspace", "logs"] as const)(
    "recovers idempotently after a failure in %s",
    async (failedStep) => {
      const { root, journal } = fixture();
      const order: string[] = [];
      let fail = true;
      const cleanup = Object.fromEntries(
        ["logicalDelete", "provider", "checkpoints", "vm", "workspace", "logs"].map((name) => [name, vi.fn(async () => {
          order.push(name);
          if (name === failedStep && fail) throw new Error("injected crash boundary");
        })]),
      ) as unknown as BotDeletionCleanup;
      const record = journal.begin("bot-1", ["thread-1", "thread-2"]);
      await expect(runBotDeletionGc(journal, record, cleanup)).rejects.toThrow("injected");
      expect(existsSync(join(root, "journal", "bot-1.json"))).toBe(true);

      fail = false;
      const pending = journal.pending();
      expect(pending).toHaveLength(1);
      await runBotDeletionGc(journal, pending[0]!, cleanup);
      expect(journal.pending()).toEqual([]);
      expect(order.at(-1)).toBe("logs");
    },
  );

  it("rejects path identities and unsafe records", () => {
    const { journal } = fixture();
    expect(() => journal.begin("../bot", ["thread"])).toThrow(/invalid/);
    expect(() => journal.begin("bot", ["../thread"])).toThrow(/invalid/);
  });
});
