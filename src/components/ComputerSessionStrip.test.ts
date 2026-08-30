import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComputerSessionStrip } from "./ComputerSessionStrip";
import type { Bot } from "@/state/store";

const now = 1_900_000_000_000;

function bot(id: string): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name: `Bot ${id}`,
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "test", model: "test" },
    messages: [],
  };
}

function screen(id: string) {
  return {
    png: Buffer.from(`pixels-${id}`).toString("base64"),
    mime: "image/png",
    at: now,
    targetKey: `computer-${id}`,
    targetGeneration: `turn-${id}`,
  };
}

function render(
  ids: string[],
  initiallyCollapsed = false,
  initiallyOverflowOpen = false,
  variant: "chat" | "panel" = "chat",
): string {
  return renderToStaticMarkup(createElement(ComputerSessionStrip, {
    bots: ids.map(bot),
    screens: Object.fromEntries(ids.map((id) => [id, screen(id)])),
    computerControl: {},
    selectedBotId: ids[0] ?? "",
    dispatch: vi.fn(),
    now,
    initiallyCollapsed,
    initiallyOverflowOpen,
    variant,
  }));
}

describe("ComputerSessionStrip", () => {
  it("renders four direct exact-bot tiles and an accessible overflow for the rest", () => {
    const markup = render(["a", "b", "c", "d", "e", "f"]);

    expect(markup.match(/data-computer-session-bot=/g)).toHaveLength(4);
    expect(markup).toContain('data-computer-session-bot="a"');
    expect(markup).toContain('data-computer-session-bot="d"');
    expect(markup).not.toContain('data-computer-session-bot="e"');
    expect(markup).toContain('aria-label="2 more computer sessions"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain('aria-label="Bot computer sessions"');

    const openMarkup = render(["a", "b", "c", "d", "e", "f"], false, true);
    expect(openMarkup).toContain('role="menu"');
    expect(openMarkup).toContain('data-computer-session-overflow-bot="e"');
    expect(openMarkup).toContain('data-computer-session-overflow-bot="f"');
  });

  it("never substitutes one bot's frame for another bot", () => {
    const markup = render(["a", "b"]);
    const aFrame = Buffer.from("pixels-a").toString("base64");
    const bFrame = Buffer.from("pixels-b").toString("base64");

    expect(markup).toContain(`data:image/png;base64,${aFrame}`);
    expect(markup).toContain(`data:image/png;base64,${bFrame}`);
    expect(markup).toContain('data-screen-bot-id="a"');
    expect(markup).toContain('data-screen-bot-id="b"');
    const aTile = markup.match(/data-computer-session-bot="a"[\s\S]*?<\/button>/)?.[0] ?? "";
    const bTile = markup.match(/data-computer-session-bot="b"[\s\S]*?<\/button>/)?.[0] ?? "";
    expect(aTile).toContain(aFrame);
    expect(aTile).not.toContain(bFrame);
    expect(bTile).toContain(bFrame);
    expect(bTile).not.toContain(aFrame);
  });

  it("is absent for one session and hides every tile when collapsed", () => {
    expect(render(["a"])).toBe("");
    const collapsed = render(["a", "b"], true);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain('aria-label="Expand computer sessions"');
    expect(collapsed).not.toContain("data-computer-session-bot");
    expect(collapsed).not.toContain('role="toolbar"');
  });

  it("uses a compact two-column layout inside the Computer panel", () => {
    const markup = render(["a", "b", "c", "d"], false, false, "panel");
    expect(markup).toContain("px-4");
    expect(markup).toContain("grid-template-columns:repeat(2, minmax(0, 1fr))");
    expect(markup).not.toContain("max-w-[900px]");
  });
});
