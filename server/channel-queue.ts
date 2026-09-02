// Follow-up messages sent while a channel is working.
//
// The renderer hands these to the harness immediately. Keeping them in a
// mounted composer loses the auto-send intent on navigation, reconnect, or a
// renderer reload. They stay off the transcript until the active channel
// operation settles so the current responder cannot appear to answer words it
// never saw.

import { newId } from "./contracts.ts";

interface ChannelQueueItem {
  id: string;
  text: string;
  replyToId?: string;
  byteLength: number;
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>();

export const MAX_QUEUED_CHANNEL_MESSAGES_PER_THREAD = 4;
export const MAX_QUEUED_CHANNEL_MESSAGES = 64;
export const MAX_QUEUED_CHANNEL_BYTES = 256 * 1024;

function queueTotals() {
  let messages = 0;
  let bytes = 0;
  for (const entry of queues.values()) {
    messages += entry.items.length;
    for (const item of entry.items) bytes += item.byteLength;
  }
  return { messages, bytes };
}

function queueLimitError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 429 });
}

export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: { replyToId?: string } = {},
): { id: string } {
  const entry = queues.get(threadId) ?? { groupId, items: [] };
  if (entry.groupId !== groupId) throw new Error("queued task belongs to another channel");
  if (entry.items.length >= MAX_QUEUED_CHANNEL_MESSAGES_PER_THREAD) {
    throw queueLimitError(`this room already has ${MAX_QUEUED_CHANNEL_MESSAGES_PER_THREAD} queued messages`);
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  const totals = queueTotals();
  if (totals.messages >= MAX_QUEUED_CHANNEL_MESSAGES) {
    throw queueLimitError("the channel queue is full — wait for pending work to finish");
  }
  if (byteLength > MAX_QUEUED_CHANNEL_BYTES || totals.bytes + byteLength > MAX_QUEUED_CHANNEL_BYTES) {
    throw queueLimitError("the channel queue has reached its text limit — wait for pending work to finish");
  }
  const item = { id: newId(), text, replyToId: options.replyToId, byteLength };
  entry.items.push(item);
  queues.set(threadId, entry);
  return { id: item.id };
}

export function pendingChannelMessageSnapshot(): Array<{
  groupId: string;
  threadId: string;
  queueId: string;
  text: string;
}> {
  return [...queues.entries()].flatMap(([threadId, entry]) =>
    entry.items.map((item) => ({
      groupId: entry.groupId,
      threadId,
      queueId: item.id,
      text: item.text,
    })),
  );
}

/** Stop is a hard boundary. Preserve queued user words in the transcript,
 * but return them to the caller instead of silently launching successors. */
export function cancelChannelMessages(groupId: string): Array<{
  threadId: string;
  queueId: string;
  text: string;
  replyToId?: string;
}> {
  const cancelled: Array<{
    threadId: string;
    queueId: string;
    text: string;
    replyToId?: string;
  }> = [];
  for (const [threadId, entry] of queues) {
    if (entry.groupId !== groupId) continue;
    queues.delete(threadId);
    for (const item of entry.items) {
      const cancelledItem: {
        threadId: string;
        queueId: string;
        text: string;
        replyToId?: string;
      } = {
        threadId,
        queueId: item.id,
        text: item.text,
      };
      if (item.replyToId) cancelledItem.replyToId = item.replyToId;
      cancelled.push(cancelledItem);
    }
  }
  return cancelled;
}

/** Start at most one follow-up per idle channel. Starting it synchronously
 * marks the channel working again; its completion drains the next item. */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => void,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    const item = entry.items[0];
    if (!item) {
      queues.delete(threadId);
      continue;
    }
    // Do not remove before the synchronous start boundary. An unexpected
    // throw leaves the item available for a later drain rather than losing
    // the user's words.
    run({ ...item, groupId: entry.groupId, threadId });
    if (queues.get(threadId) !== entry) continue;
    entry.items.shift();
    if (entry.items.length === 0) queues.delete(threadId);
  }
}

export function _queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}

export function _clearChannelQueuesForTests(): void {
  queues.clear();
}
