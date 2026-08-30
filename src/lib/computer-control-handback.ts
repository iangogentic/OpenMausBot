export interface DesktopViewerLifecycle {
  currentState(contextId: string): Promise<{ open: boolean; contextId: string }>;
  close(contextId: string): Promise<boolean>;
}

type HandbackListener = (botId: string, active: boolean) => void;

const activeHandbacks = new Set<string>();
const listeners = new Set<HandbackListener>();

function publish(botId: string, active: boolean): void {
  for (const listener of listeners) listener(botId, active);
}

export function computerHandbackInProgress(botId: string): boolean {
  return activeHandbacks.has(botId);
}

export function onComputerHandbackState(listener: HandbackListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function closeOwnedDesktopViewer(
  desktopViewer: DesktopViewerLifecycle | undefined,
  botId: string,
): Promise<boolean> {
  if (!desktopViewer) return false;
  const state = await desktopViewer.currentState(botId);
  if (!state.open || state.contextId !== botId) return false;
  const closed = await desktopViewer.close(botId);
  if (closed) return true;
  const after = await desktopViewer.currentState(botId);
  if (after.open && after.contextId === botId) {
    throw new Error("The live desktop did not close, so control is still paused");
  }
  return true;
}

/**
 * One fail-closed hand-back sequence for the panel and global banner.
 *
 * Electron hosts provider-controlled pages. Their window must be proven gone
 * before the server lease is released; browser VM/VPS tabs are instead cut
 * off by the server's lease-bound WebSocket and are closed immediately after
 * that revocation. The global in-progress signal synchronously aborts any
 * panel open/join operation before this sequence crosses the lease boundary.
 */
export async function handBackComputerControl(input: {
  botId: string;
  desktopViewer?: DesktopViewerLifecycle;
  release: () => Promise<void>;
  closeBrowserViewer: () => void;
}): Promise<void> {
  if (activeHandbacks.has(input.botId)) {
    throw new Error("Computer hand-back is already in progress");
  }
  activeHandbacks.add(input.botId);
  publish(input.botId, true);
  try {
    await closeOwnedDesktopViewer(input.desktopViewer, input.botId);
    // Let an aborted fetch/join continuation observe the synchronous signal
    // before releasing the lease. Electron IPC already creates its viewer
    // window synchronously, so the close above also catches an open call that
    // was sent before hand-back began.
    await Promise.resolve();
    await input.release();
    input.closeBrowserViewer();
    // Defense in depth for a viewer that disappeared/replaced itself between
    // the state read and close IPC. Context scoping prevents touching a
    // different bot's window.
    await closeOwnedDesktopViewer(input.desktopViewer, input.botId);
  } finally {
    activeHandbacks.delete(input.botId);
    publish(input.botId, false);
  }
}
