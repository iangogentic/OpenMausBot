import type { Action, AppState, Bot } from "@/state/store";

export const COMPUTER_SESSION_DIRECT_LIMIT = 4;
export const COMPUTER_SESSION_RECENT_MS = 5 * 60_000;

export type ComputerSessionScreen = AppState["screens"][string];

export interface ComputerSession {
  bot: Bot;
  screen: ComputerSessionScreen | undefined;
  selected: boolean;
  held: boolean;
  busy: boolean;
  recentScreen: boolean;
}

const SAFE_SCREEN_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const BASE64_CHUNK = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_THUMBNAIL_BASE64_CHARS = 16 * 1024 * 1024;

function screenCanRender(screen: ComputerSessionScreen | undefined): screen is ComputerSessionScreen {
  if (!screen) return false;
  if (!SAFE_SCREEN_MIME.has(screen.mime)) return false;
  if (!screen.targetKey.trim() || !screen.targetGeneration.trim()) return false;
  if (!screen.png || screen.png.length > MAX_THUMBNAIL_BASE64_CHARS) return false;
  // A data: URL cannot escape its fixed raster MIME, but rejecting malformed
  // edges avoids allocating another multi-megabyte string for obvious junk.
  return BASE64_CHUNK.test(screen.png.slice(0, 64)) && BASE64_CHUNK.test(screen.png.slice(-64));
}

/**
 * A live strip frame is useful only when it still carries the server's exact
 * computer and generation fences. The data URL is assembled locally from a
 * small raster allowlist, so an event can never turn the thumbnail into an
 * SVG/script or a controller-local URL fetch.
 */
export function computerSessionThumbnailSrc(
  screen: ComputerSessionScreen | undefined,
): string | null {
  if (!screenCanRender(screen)) return null;
  return `data:${screen.mime};base64,${screen.png}`;
}

function screenIsRecent(screen: ComputerSessionScreen | undefined, now: number): boolean {
  if (!screenCanRender(screen)) return false;
  return Number.isFinite(screen.at) && screen.at >= now - COMPUTER_SESSION_RECENT_MS && screen.at <= now + 60_000;
}

/**
 * Selected first, then safety-relevant held sessions, working sessions, and
 * finally the freshest idle screens. Every screen is looked up by that bot's
 * own id; there is no shared "latest frame" fallback.
 */
export function deriveComputerSessions({
  bots,
  screens,
  computerControl,
  selectedBotId,
  now,
}: {
  bots: readonly Bot[];
  screens: AppState["screens"];
  computerControl: AppState["computerControl"];
  selectedBotId: string;
  now: number;
}): ComputerSession[] {
  return bots
    .map((bot, inputIndex) => {
      const selected = bot.id === selectedBotId;
      const held = computerControl[bot.id]?.held === true;
      const computerEnabled = bot.computer !== "off";
      const busy = computerEnabled && bot.busy === true;
      const candidateScreen = screens[bot.id];
      const recentFrame = screenIsRecent(candidateScreen, now);
      const recentScreen = computerEnabled && recentFrame;
      // An expired frame is historical, not a live-session thumbnail. The
      // full Computer panel owns explicitly-labelled historical fallbacks.
      const screen = recentFrame && (computerEnabled || held) ? candidateScreen : undefined;
      return { bot, screen, selected, held, busy, recentScreen, inputIndex };
    })
    .filter((session) => session.selected || session.held || session.busy || session.recentScreen)
    .sort((left, right) => {
      if (left.selected !== right.selected) return left.selected ? -1 : 1;
      if (left.held !== right.held) return left.held ? -1 : 1;
      if (left.busy !== right.busy) return left.busy ? -1 : 1;
      const frameOrder = (right.screen?.at ?? 0) - (left.screen?.at ?? 0);
      return frameOrder || left.inputIndex - right.inputIndex;
    })
    .map(({ inputIndex: _inputIndex, ...session }) => session);
}

export function computerSessionStatus(session: ComputerSession): string {
  const states = [
    session.held ? "Control held" : null,
    session.busy ? "Working" : null,
    !session.held && !session.busy && session.recentScreen ? "Recent screen" : null,
    !session.held && !session.busy && !session.recentScreen ? "Selected" : null,
  ].filter((state): state is string => Boolean(state));
  return states.join(" · ");
}

/** Selecting/opening is intentionally only navigation. It never takes,
 * transfers, refreshes, or releases a computer-control lease. */
export function openComputerSession(dispatch: (action: Action) => void, botId: string): void {
  dispatch({ type: "select", id: botId });
  dispatch({ type: "toggleComputer", open: true });
}

export function nextComputerSessionFocusIndex(
  current: number,
  key: string,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1 + count) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  return null;
}
