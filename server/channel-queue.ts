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
}

interface ChannelQueueEntry {
  groupId: string;
  items: ChannelQueueItem[];
}

const queues = new Map<string, ChannelQueueEntry>();

export function queueChannelMessage(
  groupId: string,
  threadId: string,
  text: string,
  options: { replyToId?: string } = {},
): { id: string } {
  const entry = queues.get(threadId) ?? { groupId, items: [] };
  if (entry.groupId !== groupId) throw new Error("queued task belongs to another channel");
  const item = { id: newId(), text, replyToId: options.replyToId };
  entry.items.push(item);
  queues.set(threadId, entry);
  return { id: item.id };
}

/** Start at most one follow-up per idle channel. Starting it synchronously
 * marks the channel working again; its completion drains the next item. */
export function drainChannelMessages(
  isWorking: (groupId: string) => boolean,
  run: (input: ChannelQueueItem & { groupId: string; threadId: string }) => void,
): void {
  for (const [threadId, entry] of queues) {
    if (isWorking(entry.groupId)) continue;
    const item = entry.items.shift();
    if (!item) {
      queues.delete(threadId);
      continue;
    }
    if (entry.items.length === 0) queues.delete(threadId);
    run({ ...item, groupId: entry.groupId, threadId });
  }
}

export function _queuedChannelCount(threadId: string): number {
  return queues.get(threadId)?.items.length ?? 0;
}
