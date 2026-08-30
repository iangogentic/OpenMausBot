import { Bot, CircleCheck, CircleX, Hand, LoaderCircle } from "lucide-react";

import type { ComputerChildMonitor, ComputerChildVisualState } from "../../shared/computer-child-monitor";
import { cn } from "@/lib/cn";

const terminal = new Set<ComputerChildMonitor["status"]>(["completed", "failed", "aborted", "unknown"]);

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

export function ComputerChildMonitorStrip({
  monitors,
  visuals,
  botId,
  threadId,
}: {
  monitors: Readonly<Record<string, ComputerChildMonitor>>;
  visuals: Readonly<Record<string, ComputerChildVisualState>>;
  botId: string;
  threadId: string;
}) {
  const children = Object.values(monitors)
    .filter((monitor) => monitor.parent.botId === botId && monitor.parent.threadId === threadId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const visible = children.filter((monitor) => !terminal.has(monitor.status)).concat(
    children.filter((monitor) => terminal.has(monitor.status)).slice(0, 2),
  );
  if (!visible.length) return null;

  return (
    <section className="mx-4 mb-1 rounded-xl border border-hairline/40 bg-inset/45 p-2" aria-label="Visual operator sessions">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
        <Bot size={13} aria-hidden="true" />
        <span>Visual operators</span>
        <span className="rounded-full bg-raised px-1.5 py-0.5 tabular-nums">{visible.length}</span>
      </div>
      <div className="space-y-1">
        {visible.map((monitor) => (
          <div
            key={monitor.childId}
            data-computer-child={monitor.childId}
            data-computer-child-status={monitor.status}
            className="flex items-center justify-between gap-3 rounded-lg bg-panel/75 px-2 py-1.5"
          >
            {visuals[monitor.childId]?.frame ? (
              <div className="relative mr-1 aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-inset">
                <img
                  src={`data:${visuals[monitor.childId]!.frame!.mime};base64,${visuals[monitor.childId]!.frame!.data}`}
                  alt="Visual operator screen"
                  draggable={false}
                  className="size-full object-cover object-top"
                />
                {visuals[monitor.childId]?.cursor ? (
                  <span
                    data-computer-child-cursor
                    className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-accent shadow"
                    style={{
                      left: `${Math.max(0, Math.min(100, visuals[monitor.childId]!.cursor!.x / visuals[monitor.childId]!.frame!.width * 100))}%`,
                      top: `${Math.max(0, Math.min(100, visuals[monitor.childId]!.cursor!.y / visuals[monitor.childId]!.frame!.height * 100))}%`,
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
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
          </div>
        ))}
      </div>
    </section>
  );
}
