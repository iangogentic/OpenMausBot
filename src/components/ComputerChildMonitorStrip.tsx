import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Bot, CircleCheck, CircleX, Hand, LoaderCircle, Monitor } from "lucide-react";

import type { ComputerChildMonitor, ComputerChildVisualState } from "../../shared/computer-child-monitor";
import { cn } from "@/lib/cn";
import { previewFreshness } from "@/lib/computer-preview";

const terminal = new Set<ComputerChildMonitor["status"]>(["completed", "failed", "aborted", "unknown"]);
const SAFE_FRAME_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FRAME_BASE64_CHARS = 16 * 1024 * 1024;
const BASE64_EDGE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface ComputerChildFrameLabel {
  label: string;
  stale: boolean;
}

function statusCopy(status: ComputerChildMonitor["status"]): string {
  switch (status) {
    case "queued": return "Starting";
    case "running": return "Using computer";
    case "waiting-on-human": return "Waiting for you";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "aborted": return "Stopped";
    case "unknown": return "Needs review";
  }
}

function StatusIcon({ status }: { status: ComputerChildMonitor["status"] }) {
  if (status === "running" || status === "queued") return <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />;
  if (status === "waiting-on-human") return <Hand size={13} aria-hidden="true" />;
  if (status === "completed") return <CircleCheck size={13} aria-hidden="true" />;
  return <CircleX size={13} aria-hidden="true" />;
}

/** A child frame crosses a live transport boundary. Keep the raster and size
 * checks beside the data-URL construction so malformed state becomes an empty
 * exact-child stage, never active content or a fallback from another screen. */
export function computerChildFrameSrc(visual: ComputerChildVisualState | undefined): string | null {
  const frame = visual?.frame;
  if (!frame || !SAFE_FRAME_MIME.has(frame.mime)) return null;
  if (!Number.isFinite(frame.width) || frame.width <= 0 || !Number.isFinite(frame.height) || frame.height <= 0) return null;
  if (!frame.data || frame.data.length > MAX_FRAME_BASE64_CHARS) return null;
  if (!BASE64_EDGE.test(frame.data.slice(0, 64)) || !BASE64_EDGE.test(frame.data.slice(-64))) return null;
  return `data:${frame.mime};base64,${frame.data}`;
}

export function computerChildFrameLabel(
  monitor: ComputerChildMonitor,
  visual: ComputerChildVisualState | undefined,
  now: number,
  receivedAt = visual?.frame?.at ?? null,
): ComputerChildFrameLabel {
  const hasFrame = computerChildFrameSrc(visual) !== null;
  if (monitor.status === "completed") return { label: hasFrame ? "Final frame" : "Completed without a frame", stale: false };
  if (monitor.status === "failed") return { label: hasFrame ? "Failed · last frame" : "Failed before a frame", stale: true };
  if (monitor.status === "aborted") return { label: hasFrame ? "Stopped · last frame" : "Stopped before a frame", stale: true };
  if (monitor.status === "unknown") return { label: hasFrame ? "Needs review · last frame" : "Screen status needs review", stale: true };
  if (!hasFrame) return { label: "Waiting for first frame", stale: true };
  const freshness = previewFreshness(receivedAt, now, true);
  if (monitor.status === "waiting-on-human") {
    return { label: `Paused for you · ${freshness.label.toLowerCase()}`, stale: freshness.stale };
  }
  return freshness;
}

function Cursor({ visual, large = false }: { visual: ComputerChildVisualState; large?: boolean }) {
  const frame = visual.frame;
  const cursor = visual.cursor;
  if (!frame || !cursor || frame.width <= 0 || frame.height <= 0) return null;
  return (
    <span
      data-computer-child-cursor
      className={cn(
        "pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-accent shadow",
        large ? "size-3 ring-2 ring-black/30" : "size-2",
      )}
      style={{
        left: `${Math.max(0, Math.min(100, cursor.x / frame.width * 100))}%`,
        top: `${Math.max(0, Math.min(100, cursor.y / frame.height * 100))}%`,
      }}
    />
  );
}

function ChildFrame({ visual, large = false }: { visual: ComputerChildVisualState | undefined; large?: boolean }) {
  const src = computerChildFrameSrc(visual);
  if (!src || !visual) return null;
  return (
    <span className={cn("relative block overflow-hidden bg-inset", large ? "size-full" : "aspect-video w-20 rounded-md")}>
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn("size-full object-top", large ? "object-contain" : "object-cover")}
      />
      <Cursor visual={visual} large={large} />
    </span>
  );
}

export function nextComputerChildIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowRight" || key === "ArrowDown") return (current + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (current - 1 + count) % count;
  return null;
}

export function ComputerChildMonitorStrip({
  monitors,
  visuals,
  botId,
  threadId,
  now,
}: {
  monitors: Readonly<Record<string, ComputerChildMonitor>>;
  visuals: Readonly<Record<string, ComputerChildVisualState>>;
  botId: string;
  threadId: string;
  /** Deterministic clock for focused rendering tests. */
  now?: number;
}) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  const [requestedChildId, setRequestedChildId] = useState<string | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The harness may be on another machine with a different wall clock. Track
  // when this renderer first observes each trusted sequence rather than
  // comparing a remote timestamp with Date.now(). The map is pruned to the
  // already-bounded visible monitor set below.
  const receivedFrames = useRef(new Map<string, { seq: number; at: number }>());
  const stageId = useId();
  const children = Object.values(monitors)
    .filter((monitor) => monitor.parent.botId === botId && monitor.parent.threadId === threadId)
    .sort((a, b) => b.createdAt - a.createdAt);
  // Completed operators already publish one fenced final frame into the
  // conversation. Keeping their thumbnail and a second large stage here made
  // opening one bot's Computer panel look like several computers were open.
  // This live surface is only for operators that are still actionable.
  const visible = children.filter((monitor) => !terminal.has(monitor.status));
  const selected = visible.find((monitor) => monitor.childId === requestedChildId) ?? visible[0] ?? null;
  const visibleIds = new Set(visible.map((monitor) => monitor.childId));
  for (const childId of receivedFrames.current.keys()) {
    if (!visibleIds.has(childId)) receivedFrames.current.delete(childId);
  }
  const receivedAt = (childId: string, visual: ComputerChildVisualState | undefined) => {
    if (!visual?.frame) return null;
    const previous = receivedFrames.current.get(childId);
    if (previous?.seq === visual.frame.seq) return previous.at;
    const next = { seq: visual.frame.seq, at: now ?? Date.now() };
    receivedFrames.current.set(childId, next);
    return next.at;
  };

  useEffect(() => {
    if (now !== undefined) {
      setClock(now);
      return;
    }
    const timer = window.setInterval(() => setClock(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, [now]);

  useEffect(() => {
    if (selected && requestedChildId !== selected.childId) setRequestedChildId(selected.childId);
  }, [requestedChildId, selected]);

  if (!selected) return null;
  const selectedIndex = visible.findIndex((monitor) => monitor.childId === selected.childId);
  const selectedVisual = visuals[selected.childId];
  const selectedSrc = computerChildFrameSrc(selectedVisual);
  const selectedFrameState = computerChildFrameLabel(selected, selectedVisual, now ?? clock, receivedAt(selected.childId, selectedVisual));
  const selectedTabId = `${stageId}-tab-${selectedIndex}`;
  const moveSelection = (index: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const next = nextComputerChildIndex(index, event.key, visible.length);
    if (next === null) return;
    event.preventDefault();
    const child = visible[next];
    if (!child) return;
    setRequestedChildId(child.childId);
    tabRefs.current[next]?.focus();
  };

  return (
    <section className="mx-4 mb-1 rounded-xl border border-hairline/40 bg-inset/45 p-2" aria-label="Visual operator sessions">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
        <Bot size={13} aria-hidden="true" />
        <span>Visual operators</span>
        <span className="rounded-full bg-raised px-1.5 py-0.5 tabular-nums">{visible.length}</span>
      </div>

      <div className="space-y-1" role="tablist" aria-label="Visual operator screens" aria-orientation="vertical">
        {visible.map((monitor, index) => {
          const visual = visuals[monitor.childId];
          const frameState = computerChildFrameLabel(monitor, visual, now ?? clock, receivedAt(monitor.childId, visual));
          const isSelected = monitor.childId === selected.childId;
          return (
            <button
              key={monitor.childId}
              ref={(element) => { tabRefs.current[index] = element; }}
              type="button"
              role="tab"
              id={`${stageId}-tab-${index}`}
              aria-controls={stageId}
              aria-selected={isSelected}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setRequestedChildId(monitor.childId)}
              onKeyDown={(event) => moveSelection(index, event)}
              data-computer-child={monitor.childId}
              data-computer-child-status={monitor.status}
              data-selected={isSelected ? "true" : undefined}
              className={cn(
                "flex w-full items-center justify-between gap-3 rounded-lg border px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                isSelected ? "border-accent/55 bg-accent/10" : "border-transparent bg-panel/75 hover:border-hairline hover:bg-raised/75",
              )}
            >
              <span className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md bg-inset text-ink-secondary/65">
                <Monitor size={15} aria-hidden="true" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center justify-between gap-3">
                  <span className={cn(
                    "flex min-w-0 items-center gap-1.5 text-[11px]",
                    monitor.status === "waiting-on-human" ? "text-warning" :
                      monitor.status === "completed" ? "text-success" :
                        monitor.status === "failed" || monitor.status === "unknown" ? "text-danger" : "text-ink-secondary",
                  )}>
                    <StatusIcon status={monitor.status} />
                    <span className="truncate">{statusCopy(monitor.status)}</span>
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-ink-secondary">
                    {monitor.actionCount}/{monitor.actionLimit} actions
                  </span>
                </span>
                <span className={cn("truncate text-[9.5px]", frameState.stale ? "text-warning" : "text-ink-secondary")}>
                  {frameState.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div
        id={stageId}
        role="tabpanel"
        aria-labelledby={selectedTabId}
        data-computer-child-stage={selected.childId}
        className="mt-2 overflow-hidden rounded-lg border border-hairline/40 bg-card"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hairline/35 px-2.5 py-1.5 text-[10px]">
          <span className="font-medium text-ink">Selected operator screen</span>
          <span className={selectedFrameState.stale ? "text-warning" : "text-ink-secondary"}>{selectedFrameState.label}</span>
        </div>
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-inset">
          {selectedSrc ? <ChildFrame visual={selectedVisual} large /> : (
            <div className="flex flex-col items-center gap-2 px-5 text-center text-ink-secondary">
              {terminal.has(selected.status) ? <CircleX size={18} aria-hidden="true" /> : <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />}
              <span className="text-[11px]">{selectedFrameState.label}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
