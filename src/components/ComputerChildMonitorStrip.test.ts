import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ComputerChildMonitor } from "../../shared/computer-child-monitor";
import { ComputerChildMonitorStrip } from "./ComputerChildMonitorStrip";

function monitor(childId: string, status: ComputerChildMonitor["status"], createdAt: number): ComputerChildMonitor {
  return {
    childId,
    parent: { botId: "bot-a", threadId: "thread-a", turnId: "turn-a" },
    status,
    actionCount: 3,
    actionLimit: 9,
    leaseHeld: !["completed", "failed", "aborted"].includes(status),
    createdAt,
  };
}

describe("ComputerChildMonitorStrip", () => {
  it("renders only the exact selected bot and thread without authority details", () => {
    const exact = monitor("child-exact", "running", 3);
    const other = { ...monitor("child-other", "failed", 4), parent: { ...exact.parent, botId: "bot-b" } };
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors: { exact, other }, botId: "bot-a", threadId: "thread-a",
      visuals: {},
    }));
    expect(markup).toContain('data-computer-child="child-exact"');
    expect(markup).not.toContain("child-other");
    expect(markup).toContain("3/9 actions");
    expect(markup).not.toContain("turn-a");
  });

  it("keeps active children and bounds terminal history", () => {
    const monitors = {
      active: monitor("active", "waiting-on-human", 1),
      newest: monitor("newest", "completed", 4),
      recent: monitor("recent", "failed", 3),
      old: monitor("old", "aborted", 2),
    };
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors, botId: "bot-a", threadId: "thread-a",
      visuals: {},
    }));
    expect(markup).toContain('data-computer-child="active"');
    expect(markup).toContain('data-computer-child="newest"');
    expect(markup).toContain('data-computer-child="recent"');
    expect(markup).not.toContain('data-computer-child="old"');
    expect(markup).toContain("Waiting for you");
  });

  it("renders the exact child frame and scales its sanitized cursor", () => {
    const exact = monitor("child-exact", "running", 3);
    const data = Buffer.from("pixels").toString("base64");
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors: { exact }, botId: "bot-a", threadId: "thread-a",
      visuals: {
        "child-exact": {
          childId: "child-exact",
          lastSeq: 2,
          frame: { mime: "image/png", data, hash: "a".repeat(64), seq: 1, at: 1, width: 1000, height: 500 },
          cursor: { x: 250, y: 100, seq: 2, at: 2 },
        },
      },
    }));
    expect(markup).toContain(`data:image/png;base64,${data}`);
    expect(markup).toContain("data-computer-child-cursor");
    expect(markup).toContain("left:25%");
    expect(markup).toContain("top:20%");
  });
});
