import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildSidebarBotPreview, SidebarBotPreview } from "./SidebarBotPreview";
import type { Attachment } from "@/lib/composer-attachments";
import type { Bot, Message } from "@/state/store";

function message(id: string, text: string, at: number, parentId?: string | null): Message {
  return { id, role: "bot", kind: "text", text, at, parentId };
}

function bot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "maus",
    threadId: "thread-maus",
    name: "Hermes",
    title: "Computer operator",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "test", model: "test" },
    messages: [],
    ...patch,
  };
}

function store(draft: string, attachments: Attachment[] = []): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: (key) => {
      if (key === "omb-drafts") return JSON.stringify({ maus: draft });
      if (key === "omb-draft-attachments") return JSON.stringify({ maus: attachments });
      return null;
    },
    setItem: () => undefined,
  };
}

describe("sidebar bot preview summary", () => {
  it("uses the visible branch for latest while retaining the specifically pinned message", () => {
    const root = message("root", "Start", 1, null);
    const visible = message("visible", "Visible answer", 2, "root");
    const hidden = message("hidden", "Hidden fork", 3, "root");
    const summary = buildSidebarBotPreview(bot({
      messages: [root, visible, hidden],
      activeLeafId: "visible",
      pinnedMessageId: "hidden",
    }));

    expect(summary.latest).toBe("Visible answer");
    expect(summary.pinned).toBe("Hidden fork");
  });

  it("summarizes draft text plus recent and pending attachments without exposing paths", () => {
    const data = store("  Finish the launch notes tomorrow  ", [
      { id: "draft-file", kind: "file", path: "/private/roadmap.pdf", name: "roadmap.pdf", size: 42 },
    ]);
    const summary = buildSidebarBotPreview(bot({
      messages: [message("file", 'Ready <attached-image path="/private/screen.png" />', 1)],
    }), data);

    expect(summary.draft).toBe("Finish the launch notes tomorrow");
    expect(summary.attachments).toBe("2 attachments · screen.png");
    expect(JSON.stringify(summary)).not.toContain("/private/");
  });

  it("maps live activity to plain status language", () => {
    expect(buildSidebarBotPreview(bot({ busy: true })).status).toBe("Working");
    expect(buildSidebarBotPreview(bot({ activity: "waiting-on-you" })).status).toBe("Waiting for you");
    expect(buildSidebarBotPreview(bot({ activity: "no-signal" })).status).toBe("No signal");
    expect(buildSidebarBotPreview(bot()).status).toBe("Ready");
  });
});

describe("SidebarBotPreview", () => {
  it("renders one non-interactive tooltip with status, latest, pinned, draft, and attachments", () => {
    const data = store("Draft response");
    const markup = renderToStaticMarkup(createElement(SidebarBotPreview, {
      bot: bot({
        pinned: true,
        pinnedMessageId: "pinned",
        activity: "working",
        messages: [
          message("pinned", "Keep this decision", 1),
          message("latest", 'Latest update <attached-file path="/secret/report.pdf" />', 2),
        ],
      }),
      store: data,
    }));

    expect(markup).toContain('role="tooltip"');
    expect(markup).toContain('data-preview-status="working"');
    expect(markup).toContain('data-preview-row="latest"');
    expect(markup).toContain('data-preview-row="pinned"');
    expect(markup).toContain('data-preview-row="draft"');
    expect(markup).toContain('data-preview-row="attachments"');
    expect(markup).toContain("Pinned bot");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("/secret/");
  });
});
