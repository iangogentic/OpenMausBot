import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ChevronDown, ChevronUp, Monitor, MoreHorizontal } from "lucide-react";

import { BotAvatar } from "./Avatar";
import { cn } from "@/lib/cn";
import {
  COMPUTER_SESSION_DIRECT_LIMIT,
  computerSessionStatus,
  computerSessionThumbnailSrc,
  deriveComputerSessions,
  nextComputerSessionFocusIndex,
  openComputerSession,
  type ComputerSession,
} from "@/lib/computer-session-strip";
import type { Action, AppState, Bot } from "@/state/store";

export interface ComputerSessionStripProps {
  bots: readonly Bot[];
  screens: AppState["screens"];
  computerControl: AppState["computerControl"];
  selectedBotId: string;
  dispatch: (action: Action) => void;
  /** A fixed clock is useful for deterministic previews and tests. */
  now?: number;
  /** Test/embedding hook; the app starts expanded. */
  initiallyCollapsed?: boolean;
  /** Test/embedding hook; ordinary app use starts with the menu closed. */
  initiallyOverflowOpen?: boolean;
}

function statusTone(session: ComputerSession): string {
  if (session.held) return "bg-warning";
  if (session.busy) return "animate-pulse bg-accent";
  if (session.recentScreen) return "bg-success";
  return "bg-ink-secondary";
}

function ScreenThumbnail({ session, compact = false }: { session: ComputerSession; compact?: boolean }) {
  const src = useMemo(() => computerSessionThumbnailSrc(session.screen), [session.screen]);
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden bg-inset",
        compact ? "size-10 rounded-md" : "aspect-video w-full rounded-md",
      )}
    >
      {src ? (
        <img
          src={src}
          alt={`${session.bot.name}'s computer preview`}
          draggable={false}
          data-screen-bot-id={session.bot.id}
          className="size-full object-cover object-top"
        />
      ) : (
        <Monitor size={compact ? 16 : 20} aria-hidden="true" className="text-ink-secondary/65" />
      )}
      <span
        aria-hidden="true"
        className={cn(
          "absolute right-1 top-1 size-2 rounded-full ring-2 ring-inset ring-panel",
          statusTone(session),
        )}
      />
    </span>
  );
}

function SessionName({ session }: { session: ComputerSession }) {
  return (
    <span className="mt-1 flex min-w-0 items-center gap-1.5 px-0.5">
      <BotAvatar bot={session.bot} state={session.busy ? "working" : "idle"} size={18} animated={false} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium leading-tight text-ink">{session.bot.name}</span>
        <span className="block truncate text-[9px] leading-tight text-ink-secondary">{computerSessionStatus(session)}</span>
      </span>
    </span>
  );
}

export function ComputerSessionStrip({
  bots,
  screens,
  computerControl,
  selectedBotId,
  dispatch,
  now,
  initiallyCollapsed = false,
  initiallyOverflowOpen = false,
}: ComputerSessionStripProps) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [overflowOpen, setOverflowOpen] = useState(initiallyOverflowOpen);
  const stripId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toolbarRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuFocusIndex = useRef(0);

  useEffect(() => {
    if (now !== undefined) return;
    const timer = window.setInterval(() => setClock(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [now]);

  useEffect(() => {
    if (!overflowOpen) return;
    const focus = window.requestAnimationFrame(() => menuRefs.current[menuFocusIndex.current]?.focus());
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => {
      window.cancelAnimationFrame(focus);
      document.removeEventListener("pointerdown", closeOutside);
    };
  }, [overflowOpen]);

  useEffect(() => setOverflowOpen(false), [selectedBotId]);

  const sessions = useMemo(
    () => deriveComputerSessions({
      bots,
      screens,
      computerControl,
      selectedBotId,
      now: now ?? clock,
    }),
    [bots, screens, computerControl, selectedBotId, now, clock],
  );

  // A single session is already represented by the ordinary Computer button
  // and panel. The strip earns its space only when there is something to
  // switch between.
  if (sessions.length <= 1) return null;

  const direct = sessions.slice(0, COMPUTER_SESSION_DIRECT_LIMIT);
  const overflow = sessions.slice(COMPUTER_SESSION_DIRECT_LIMIT);
  const toolbarCount = direct.length + (overflow.length > 0 ? 1 : 0);

  const focusToolbar = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const next = nextComputerSessionFocusIndex(index, event.key, toolbarCount);
    if (next === null) return;
    event.preventDefault();
    toolbarRefs.current[next]?.focus();
  };

  const focusMenu = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOverflowOpen(false);
      toolbarRefs.current[direct.length]?.focus();
      return;
    }
    const next = nextComputerSessionFocusIndex(index, event.key, overflow.length);
    if (next === null) return;
    event.preventDefault();
    menuRefs.current[next]?.focus();
  };

  return (
    <div
      ref={rootRef}
      data-computer-session-strip
      data-session-count={sessions.length}
      className="relative z-20 mx-auto w-full max-w-[900px] shrink-0 px-5 pb-2"
    >
      <div className="rounded-xl border border-hairline/40 bg-panel/80 p-1.5 shadow-sm backdrop-blur">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
            <Monitor size={13} aria-hidden="true" />
            <span className="truncate">Computer sessions</span>
            <span className="rounded-full bg-raised px-1.5 py-0.5 tabular-nums">{sessions.length}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setCollapsed((value) => !value);
              setOverflowOpen(false);
            }}
            aria-expanded={!collapsed}
            aria-controls={stripId}
            aria-label={collapsed ? "Expand computer sessions" : "Collapse computer sessions"}
            className="rounded-md p-1 text-ink-secondary hover:bg-raised hover:text-ink"
          >
            {collapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </div>

        {!collapsed && (
          <div id={stripId} className="mt-1 flex min-w-0 items-stretch gap-1.5" role="toolbar" aria-label="Bot computer sessions">
            <div
              className="grid min-w-0 flex-1 gap-1.5"
              style={{ gridTemplateColumns: `repeat(${direct.length}, minmax(0, 1fr))` }}
            >
              {direct.map((session, index) => (
                <button
                  key={session.bot.id}
                  ref={(node) => { toolbarRefs.current[index] = node; }}
                  type="button"
                  onClick={() => openComputerSession(dispatch, session.bot.id)}
                  onKeyDown={(event) => focusToolbar(index, event)}
                  aria-label={`Open ${session.bot.name}'s computer — ${computerSessionStatus(session)}`}
                  aria-pressed={session.selected}
                  data-computer-session-bot={session.bot.id}
                  data-selected={session.selected ? "true" : undefined}
                  className={cn(
                    "min-w-0 rounded-lg border p-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    session.selected
                      ? "border-accent/70 bg-accent/10"
                      : "border-transparent bg-inset/60 hover:border-hairline hover:bg-raised/70",
                  )}
                >
                  <ScreenThumbnail session={session} />
                  <SessionName session={session} />
                </button>
              ))}
            </div>

            {overflow.length > 0 && (
              <div className="relative flex w-11 shrink-0">
                <button
                  ref={(node) => { toolbarRefs.current[direct.length] = node; }}
                  type="button"
                  onClick={() => {
                    menuFocusIndex.current = 0;
                    setOverflowOpen((value) => !value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setOverflowOpen(false);
                      return;
                    }
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      menuFocusIndex.current = event.key === "ArrowUp" ? overflow.length - 1 : 0;
                      setOverflowOpen(true);
                      return;
                    }
                    focusToolbar(direct.length, event);
                  }}
                  aria-label={`${overflow.length} more computer sessions`}
                  aria-haspopup="menu"
                  aria-expanded={overflowOpen}
                  className="flex w-full flex-col items-center justify-center rounded-lg border border-transparent bg-inset/60 text-ink-secondary hover:border-hairline hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  <MoreHorizontal size={18} />
                  <span className="text-[10px] tabular-nums">+{overflow.length}</span>
                </button>

                {overflowOpen && (
                  <div
                    role="menu"
                    aria-label="More computer sessions"
                    className="absolute right-0 top-full z-50 mt-1 w-64 rounded-xl border border-hairline bg-panel p-1.5 shadow-2xl"
                  >
                    {overflow.map((session, index) => (
                      <button
                        key={session.bot.id}
                        ref={(node) => { menuRefs.current[index] = node; }}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setOverflowOpen(false);
                          openComputerSession(dispatch, session.bot.id);
                        }}
                        onKeyDown={(event) => focusMenu(index, event)}
                        data-computer-session-overflow-bot={session.bot.id}
                        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
                      >
                        <ScreenThumbnail session={session} compact />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-ink">{session.bot.name}</span>
                          <span className="block truncate text-[11px] text-ink-secondary">{computerSessionStatus(session)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
