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
    }));
    expect(markup).toContain('data-computer-child="active"');
    expect(markup).toContain('data-computer-child="newest"');
    expect(markup).toContain('data-computer-child="recent"');
    expect(markup).not.toContain('data-computer-child="old"');
    expect(markup).toContain("Waiting for you");
  });
});
