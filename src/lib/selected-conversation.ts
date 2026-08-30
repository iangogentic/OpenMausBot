export const SELECTED_CONVERSATION_KEY = "openmausbot.selectedConversation";

function storage(): Storage | null {
  try {
    return globalThis.window ? globalThis.window.localStorage : null;
  } catch {
    return null;
  }
}

export function readSelectedConversationId(): string {
  try {
    return storage()?.getItem(SELECTED_CONVERSATION_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeSelectedConversationId(id: string): void {
  const normalized = id.trim();
  if (!normalized) return;
  try {
    storage()?.setItem(SELECTED_CONVERSATION_KEY, normalized);
  } catch {
    // Locked-down storage must not make navigation fail.
  }
}
