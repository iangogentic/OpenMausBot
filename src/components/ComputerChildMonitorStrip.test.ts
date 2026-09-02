import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ComputerChildMonitor } from "../../shared/computer-child-monitor";
import {
  ComputerChildMonitorStrip,
  computerChildFrameLabel,
  computerChildFrameSrc,
  nextComputerChildIndex,
} from "./ComputerChildMonitorStrip";

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

  it("shows only actionable children and leaves terminal frames in the conversation", () => {
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
    expect(markup).not.toContain('data-computer-child="newest"');
    expect(markup).not.toContain('data-computer-child="recent"');
    expect(markup).not.toContain('data-computer-child="old"');
    expect(markup).toContain("Waiting for you");
  });

  it("renders the exact child frame and scales its sanitized cursor", () => {
    const exact = monitor("child-exact", "running", 3);
    const data = Buffer.from("pixels").toString("base64");
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors: { exact }, botId: "bot-a", threadId: "thread-a",
      now: 2,
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
    expect(markup.match(new RegExp(data, "g"))).toHaveLength(1);
    expect(markup).toContain("data-computer-child-cursor");
    expect(markup).toContain("left:25%");
    expect(markup).toContain("top:20%");
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('data-computer-child-stage="child-exact"');
    expect(markup).toContain("Selected operator screen");
  });

  it("selects only the newest visible exact child for the large stage", () => {
    const older = monitor("older", "running", 2);
    const newer = monitor("newer", "running", 3);
    const olderData = Buffer.from("older pixels").toString("base64");
    const newerData = Buffer.from("newer pixels").toString("base64");
    const frame = (childId: string, data: string) => ({
      childId,
      lastSeq: 1,
      frame: { mime: "image/png" as const, data, hash: "a".repeat(64), seq: 1, at: 10, width: 100, height: 50 },
    });
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors: { older, newer }, botId: "bot-a", threadId: "thread-a", now: 10,
      visuals: { older: frame("older", olderData), newer: frame("newer", newerData) },
    }));
    expect(markup).toContain('data-computer-child-stage="newer"');
    expect(markup).toContain('data-computer-child="newer"');
    expect(markup).toContain('data-selected="true"');
    expect(markup).toContain('tabindex="-1"');
  });

  it("exposes deterministic keyboard tab selection", () => {
    expect(nextComputerChildIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextComputerChildIndex(0, "ArrowLeft", 3)).toBe(2);
    expect(nextComputerChildIndex(1, "Home", 3)).toBe(0);
    expect(nextComputerChildIndex(1, "End", 3)).toBe(2);
    expect(nextComputerChildIndex(1, "Enter", 3)).toBeNull();
  });

  it("labels first-frame, stale, final and failed states truthfully", () => {
    const running = monitor("running", "running", 1);
    const completed = monitor("completed", "completed", 2);
    const failed = monitor("failed", "failed", 3);
    const visual = {
      childId: "running",
      lastSeq: 1,
      frame: { mime: "image/png" as const, data: Buffer.from("pixels").toString("base64"), hash: "b".repeat(64), seq: 1, at: 1_000, width: 100, height: 50 },
    };
    expect(computerChildFrameLabel(running, undefined, 1_000)).toEqual({ label: "Waiting for first frame", stale: true });
    expect(computerChildFrameLabel(running, visual, 20_000)).toEqual({ label: "Stale · 19s ago", stale: true });
    expect(computerChildFrameLabel(running, visual, 20_000, 19_000)).toEqual({ label: "Live · now", stale: false });
    expect(computerChildFrameLabel(completed, { ...visual, childId: "completed" }, 20_000)).toEqual({ label: "Final frame", stale: false });
    expect(computerChildFrameLabel(failed, undefined, 20_000)).toEqual({ label: "Failed before a frame", stale: true });
  });

  it("rejects malformed child pixels instead of displaying another screen", () => {
    const invalid = {
      childId: "invalid",
      lastSeq: 1,
      frame: { mime: "image/png" as const, data: "not base64!", hash: "c".repeat(64), seq: 1, at: 1, width: 100, height: 50 },
    };
    expect(computerChildFrameSrc(invalid)).toBeNull();
    const exact = monitor("invalid", "running", 1);
    const markup = renderToStaticMarkup(createElement(ComputerChildMonitorStrip, {
      monitors: { exact }, botId: "bot-a", threadId: "thread-a", now: 1, visuals: { invalid },
    }));
    expect(markup).toContain('data-computer-child-stage="invalid"');
    expect(markup).toContain("Waiting for first frame");
    expect(markup).not.toContain("data:image");
  });
});
