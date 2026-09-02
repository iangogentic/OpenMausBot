// Queue-and-steer for busy 1:1 bots.
//
// A message sent to a bot mid-turn used to bounce with a 409. Now it waits
// here until the bot settles, then lands in the thread and runs as ONE
// follow-up turn whose prompt is the queued texts joined with newlines.
//
// The queue is memory-only and is NOT in `messages[]` while the current
// turn is running: appending immediately would make the queued line the
// active leaf, so remaining tool/assistant events of *this* turn would
// hang off a user line the model has not seen. Restart loses the queue
// (same as delegations / approvals). The composer shows a pending chip
// until drain appends the words.
//
// A provider failure may still drain this queue, but a literal user Stop is
// stronger: it preserves the words in the transcript without silently
// launching a successor turn after Stop returned.

import { newId } from "./contracts.ts";
import type { BotRecord, Message } from "./store.ts";

/** The slice of Store this module needs — narrow so tests can fake it. */
export interface SteerStore {
  bot(id: string): BotRecord | null;
  appendMessage(threadId: string, message: Omit<Message, "id" | "at">): Message;
  patchMessage(threadId: string, messageId: string, patch: Partial<Message>): Message | null;
}

interface QueueEntry {
  /** Kept beside the threadId because the settle that frees the bot can
   * happen on a DIFFERENT thread (a room turn) — drain matches on "this
   * queue's bot is idle now", which needs the bot, not the settling thread. */
  botId: string;
  items: Array<{ messageId: string; text: string; prompt: string; replyToId?: string; byteLength: number }>;
}

const queues = new Map<string, QueueEntry>(); // threadId → waiting sends

export const MAX_QUEUED_STEER_MESSAGES_PER_THREAD = 4;
export const MAX_QUEUED_STEER_MESSAGES = 64;
export const MAX_QUEUED_STEER_BYTES = 256 * 1024;

function steerQueueTotals() {
  let messages = 0;
  let bytes = 0;
  for (const entry of queues.values()) {
    messages += entry.items.length;
    for (const item of entry.items) bytes += item.byteLength;
  }
  return { messages, bytes };
}

function steerQueueLimitError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 429 });
}

/** Hold a mid-turn send off the transcript until drain. */
export function queueSteeredMessage(
  bot: BotRecord,
  text: string,
  options: { prompt?: string; replyToId?: string } = {},
): { id: string } {
  const threadId = bot.threadId;
  const id = newId();
  const entry = queues.get(threadId) ?? { botId: bot.id, items: [] };
  if (entry.botId !== bot.id) throw new Error("queued task belongs to another bot");
  if (entry.items.length >= MAX_QUEUED_STEER_MESSAGES_PER_THREAD) {
    throw steerQueueLimitError(`this chat already has ${MAX_QUEUED_STEER_MESSAGES_PER_THREAD} queued messages`);
  }
  const prompt = options.prompt ?? text;
  const byteLength = Buffer.byteLength(text, "utf8") + Buffer.byteLength(prompt, "utf8");
  const totals = steerQueueTotals();
  if (totals.messages >= MAX_QUEUED_STEER_MESSAGES) {
    throw steerQueueLimitError("the chat queue is full — wait for pending work to finish");
  }
  if (byteLength > MAX_QUEUED_STEER_BYTES || totals.bytes + byteLength > MAX_QUEUED_STEER_BYTES) {
    throw steerQueueLimitError("the chat queue has reached its text limit — wait for pending work to finish");
  }
  entry.items.push({ messageId: id, text, prompt, replyToId: options.replyToId, byteLength });
  queues.set(threadId, entry);
  return { id };
}

/** Authenticated UI hydration receipt. Prompts and provider metadata stay
 * private; the renderer needs only enough to restore its pending chip. */
export function pendingSteeredMessageSnapshot(): Array<{
  threadId: string;
  queueId: string;
  text: string;
}> {
  return [...queues.entries()].flatMap(([threadId, entry]) =>
    entry.items.map((item) => ({ threadId, queueId: item.messageId, text: item.text })),
  );
}

/** Drain every queue whose bot is idle: append the held lines (leaf is now
 * the finished turn's last item), then one run per thread whose prompt is
 * the texts joined with newlines. `userMessage` is the last appended line
 * so startTurn does not duplicate it; `excludeIds` is every drained line
 * so transcript-replay adapters do not also see earlier queued texts.
 * Entries leave the map BEFORE running so a settle racing another settle
 * can never fire the same queue twice. */
export function drainSteeredMessages(
  store: SteerStore,
  run: (
    botId: string,
    threadId: string,
    prompt: string,
    userMessage: Message,
    excludeIds: string[],
  ) => void | Promise<void>,
): void {
  // deleting only the entry being visited is safe under Map iteration
  for (const [threadId, entry] of queues) {
    const bot = store.bot(entry.botId);
    if (!bot) {
      // the bot was deleted while messages waited — nothing left to steer
      queues.delete(threadId);
      continue;
    }
    if (bot.busy) continue; // still working — the next settle tries again
    // committed to draining: the entry leaves the map before anything runs,
    // so a settle racing another settle can never fire the same queue twice
    queues.delete(threadId);
    const appended: Message[] = [];
    for (const item of entry.items) {
      // queueId is the pending-chip identity from the 202; append still
      // assigns a fresh transcript id so replay/exclude keep using message.id.
      appended.push(
        store.appendMessage(threadId, {
          role: "user",
          kind: "text",
          text: item.text,
          replyToId: item.replyToId,
          queueId: item.messageId,
        }),
      );
    }
    const last = appended.at(-1);
    if (!last) continue;
    const prompt = entry.items.map((item) => item.prompt).join("\n");
    void run(
      entry.botId,
      threadId,
      prompt,
      last,
      appended.map((message) => message.id),
    );
  }
}

/**
 * A literal Stop is stronger than a turn settlement: queued user words are
 * preserved in the transcript, but they do not silently become a successor
 * provider turn after Stop returned. Returning the affected threads lets the
 * harness append one visible explanation per conversation.
 */
export function cancelSteeredMessages(store: SteerStore, botId: string): string[] {
  const affected: string[] = [];
  for (const [threadId, entry] of queues) {
    if (entry.botId !== botId) continue;
    queues.delete(threadId);
    affected.push(threadId);
    for (const item of entry.items) {
      store.appendMessage(threadId, {
        role: "user",
        kind: "text",
        text: item.text,
        replyToId: item.replyToId,
        queueId: item.messageId,
      });
    }
  }
  return affected;
}

/** Test helper: how many messages remain queued for a thread. */
export function _queuedCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

export function _clearSteeredQueuesForTests(): void {
  queues.clear();
}
