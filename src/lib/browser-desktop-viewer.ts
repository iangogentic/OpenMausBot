/** Lifecycle tracking for the plain-web live-desktop tab.
 *
 * Electron has a first-class viewer window and emits close events. A normal
 * browser does not, so the app must retain the Window handle and observe
 * `closed`; otherwise its global lease heartbeat can pause the bot forever
 * after the person closes noVNC. This module lives outside React so tracking
 * survives panel collapse and bot switches. */

export interface BrowserDesktopViewerHandle {
  readonly closed: boolean;
  close(): void;
  focus(): void;
}

type CloseHandler = () => void | Promise<void>;
type StateListener = (botId: string, open: boolean) => void;

interface BrowserViewerRecord {
  handle: BrowserDesktopViewerHandle;
  onUnexpectedClose: CloseHandler;
}

const records = new Map<string, BrowserViewerRecord>();
const listeners = new Set<StateListener>();
let pollTimer: ReturnType<typeof setInterval> | null = null;

function handleIsClosed(handle: BrowserDesktopViewerHandle): boolean {
  try {
    return handle.closed;
  } catch {
    // Losing access to the WindowProxy is not proof that a controllable viewer
    // still exists. Fail toward releasing the bot, not an endless pause.
    return true;
  }
}

function notify(botId: string, open: boolean): void {
  for (const listener of listeners) listener(botId, open);
}

function stopTimerIfIdle(): void {
  if (records.size !== 0 || pollTimer === null) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

function ensureTimer(): void {
  if (pollTimer !== null) return;
  pollTimer = setInterval(pollBrowserDesktopViewers, 500);
}

/** Exposed for deterministic tests; production also calls it every 500 ms. */
export function pollBrowserDesktopViewers(): void {
  for (const [botId, record] of records) {
    if (!handleIsClosed(record.handle)) continue;
    records.delete(botId);
    notify(botId, false);
    void Promise.resolve(record.onUnexpectedClose()).catch(() => {});
  }
  stopTimerIfIdle();
}

export function trackBrowserDesktopViewer(
  botId: string,
  handle: BrowserDesktopViewerHandle,
  onUnexpectedClose: CloseHandler,
): void {
  const previous = records.get(botId);
  if (previous && previous.handle !== handle) {
    // Replacement is deliberate and keeps the same exact control lease. Do
    // not run the old tab's close callback and accidentally release the new.
    records.delete(botId);
    try { previous.handle.close(); } catch {}
  }
  records.set(botId, { handle, onUnexpectedClose });
  notify(botId, true);
  ensureTimer();
  pollBrowserDesktopViewers();
}

export function focusBrowserDesktopViewer(botId: string): boolean {
  pollBrowserDesktopViewers();
  const record = records.get(botId);
  if (!record) return false;
  try { record.handle.focus(); } catch {}
  return true;
}

/** Explicit hand-back closes the tab without firing the unexpected-close
 * callback because the caller has already released the exact lease. */
export function closeBrowserDesktopViewer(botId: string): boolean {
  const record = records.get(botId);
  if (!record) return false;
  records.delete(botId);
  notify(botId, false);
  try { record.handle.close(); } catch {}
  stopTimerIfIdle();
  return true;
}

export function browserDesktopViewerIsOpen(botId: string): boolean {
  pollBrowserDesktopViewers();
  return records.has(botId);
}

export function onBrowserDesktopViewerState(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Close tracked tabs without invoking release callbacks. Used by tests and
 * by callers that are already tearing down all authority. */
export function clearBrowserDesktopViewers(): void {
  for (const [botId, record] of records) {
    records.delete(botId);
    notify(botId, false);
    try { record.handle.close(); } catch {}
  }
  stopTimerIfIdle();
}
