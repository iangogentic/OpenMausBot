import { FileText, MessageCircle, Paperclip, Pin } from "lucide-react";

import { attachmentBasename } from "@/lib/composer-attachments";
import { getDraft, getDraftAttachments } from "@/lib/drafts";
import { replySnippet } from "@/lib/replies";
import { cn } from "@/lib/cn";
import { visibleMessages, type Bot, type Message } from "@/state/store";

type PreviewStore = Pick<Storage, "getItem" | "setItem"> | undefined;

function browserStore(): PreviewStore {
  try {
    return "localStorage" in globalThis ? globalThis.localStorage : undefined;
  } catch {
    return undefined;
  }
}

export interface SidebarBotPreviewSummary {
  status: string;
  statusTone: "accent" | "danger" | "quiet" | "waiting";
  latest: string;
  pinned: string | null;
  draft: string | null;
  attachments: string | null;
}

function messageSummary(message: Message | undefined): string {
  if (!message) return "No messages yet";
  if (message.kind === "options" && message.card) return message.card.title;
  if (message.kind === "activity" && message.tool) return message.tool.name;
  if (message.kind === "screen") return "Computer screen updated";
  if (message.kind === "connector" && message.connector) return message.connector.label;
  if (message.kind === "secret" && message.secret) return message.secret.label;
  const safeText = (message.text ?? "")
    .replace(/<attached-image\s+path="[^"]*"\s*\/>/g, "[image]")
    .replace(/<attached-file\s+path="[^"]*"(?:\s+attachment-id="[^"]*")?\s*\/>/g, "[file]");
  return replySnippet(safeText) || "Message without text";
}

function attachmentNames(messages: Message[]): string[] {
  const names: string[] = [];
  for (const message of messages) {
    for (const match of (message.text ?? "").matchAll(/<attached-(?:image|file)\s+path="([^"]*)"(?:\s+attachment-id="[^"]*")?\s*\/>/g)) {
      const name = attachmentBasename(match[1] ?? "");
      if (name) names.push(name.replaceAll("&amp;", "&").replaceAll("&quot;", '"'));
    }
  }
  return names;
}

function compact(text: string, limit = 120): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1).trimEnd()}…` : oneLine;
}

/** Builds the one canonical summary used for pointer and keyboard previews. */
export function buildSidebarBotPreview(
  bot: Bot,
  store?: PreviewStore,
): SidebarBotPreviewSummary {
  const visible = visibleMessages(bot);
  const pinnedMessage = bot.pinnedMessageId
    ? bot.messages.find((message) => message.id === bot.pinnedMessageId)
    : undefined;
  const draft = compact(getDraft(store, bot.id));
  const draftAttachments = getDraftAttachments(store, bot.id);
  const allRecentNames = attachmentNames(visible.slice().reverse());
  const recentNames = allRecentNames.slice(0, 3);
  const attachmentCount = allRecentNames.length + draftAttachments.length;
  const attachmentDetail = recentNames.length
    ? `${recentNames.join(", ")}${allRecentNames.length > recentNames.length ? ", …" : ""}`
    : draftAttachments.length
      ? `${draftAttachments.length} in draft`
      : "";

  const status = bot.activity === "waiting-on-you"
    ? { status: "Waiting for you", statusTone: "waiting" as const }
    : bot.busy || bot.activity === "working"
      ? { status: "Working", statusTone: "accent" as const }
      : bot.activity === "dead"
        ? { status: "Stopped", statusTone: "danger" as const }
        : bot.activity === "no-signal"
          ? { status: "No signal", statusTone: "danger" as const }
          : { status: "Ready", statusTone: "quiet" as const };

  return {
    ...status,
    latest: messageSummary(visible.at(-1)),
    pinned: pinnedMessage ? messageSummary(pinnedMessage) : null,
    draft: draft || (draftAttachments.length ? "Attachment draft" : null),
    attachments: attachmentCount
      ? `${attachmentCount} ${attachmentCount === 1 ? "attachment" : "attachments"}${attachmentDetail ? ` · ${attachmentDetail}` : ""}`
      : null,
  };
}

function SummaryRow({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2.5" data-preview-row={testId}>
      <span className="mt-0.5 text-ink-secondary" aria-hidden="true">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">{label}</div>
        <div className="mt-0.5 line-clamp-2 text-[12.5px] leading-[1.4] text-ink">{value}</div>
      </div>
    </div>
  );
}

export function SidebarBotPreview({ bot, store }: { bot: Bot; store?: PreviewStore }) {
  const summary = buildSidebarBotPreview(bot, store ?? browserStore());
  return (
    <section
      id={`sidebar-bot-preview-${bot.id}`}
      role="tooltip"
      aria-label={`${bot.name} summary`}
      data-sidebar-bot-preview={bot.id}
      className="w-[min(292px,calc(100vw-16px))] overflow-hidden rounded-2xl border border-hairline/60 bg-card shadow-2xl shadow-black/45"
    >
      <header className="flex items-start justify-between gap-3 border-b border-hairline/40 px-4 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-ink">{bot.name}</span>
            {bot.pinned && <Pin size={11} className="shrink-0 text-ink-secondary" aria-label="Pinned bot" />}
          </div>
          {bot.title && <div className="mt-0.5 truncate text-[11.5px] text-ink-secondary">{bot.title}</div>}
        </div>
        <span className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px] font-medium",
          summary.statusTone === "accent" && "bg-accent/15 text-accent",
          summary.statusTone === "waiting" && "bg-warning/15 text-warning",
          summary.statusTone === "danger" && "bg-danger/15 text-danger",
          summary.statusTone === "quiet" && "bg-raised text-ink-secondary",
        )} data-preview-status={summary.status.toLowerCase().replaceAll(" ", "-")}>
          <span className={cn(
            "size-1.5 rounded-full",
            summary.statusTone === "accent" && "bg-accent",
            summary.statusTone === "waiting" && "bg-warning",
            summary.statusTone === "danger" && "bg-danger",
            summary.statusTone === "quiet" && "bg-ink-secondary/60",
          )} />
          {summary.status}
        </span>
      </header>
      <div className="space-y-3 px-4 py-3.5">
        <SummaryRow icon={<MessageCircle size={14} />} label="Latest" value={summary.latest} testId="latest" />
        {summary.pinned && <SummaryRow icon={<Pin size={14} />} label="Pinned" value={summary.pinned} testId="pinned" />}
        {summary.draft && <SummaryRow icon={<FileText size={14} />} label="Draft" value={summary.draft} testId="draft" />}
        {summary.attachments && <SummaryRow icon={<Paperclip size={14} />} label="Attachments" value={summary.attachments} testId="attachments" />}
      </div>
    </section>
  );
}
