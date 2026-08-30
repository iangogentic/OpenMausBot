import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import {
  botDeletionConfirmation,
  computerPanelVisible,
  configStatusFromFrame,
  initialState,
  openNotificationTarget,
  reducer,
  screenTransportUrl,
  type Bot,
  type Group,
  type Message,
} from "./store";
import type { ComputerChildMonitor } from "../../shared/computer-child-monitor";

function childMonitor(index: number, status: ComputerChildMonitor["status"] = "completed"): ComputerChildMonitor {
  return {
    childId: `child-${index}`,
    parent: { botId: "bot", threadId: "thread", turnId: "turn" },
    status,
    actionCount: 1,
    actionLimit: 9,
    leaseHeld: status === "running",
    createdAt: index,
  };
}

function openComputerState() {
  return {
    ...initialState,
    bots: [{ id: "bot" } as Bot],
    selectedId: "bot",
    computerOpen: true,
  };
}

describe("computer child monitor fold", () => {
  it("updates exact children and bounds terminal history without dropping active work", () => {
    let state = initialState;
    state = reducer(state, { type: "computerChild", monitor: childMonitor(-1, "running") });
    for (let index = 0; index < 140; index += 1) {
      state = reducer(state, { type: "computerChild", monitor: childMonitor(index) });
    }
    expect(Object.keys(state.computerChildren)).toHaveLength(128);
    expect(state.computerChildren["child--1"]?.status).toBe("running");
    expect(state.computerChildren["child-0"]).toBeUndefined();
    expect(state.computerChildren["child-139"]?.status).toBe("completed");
  });

  it("rejects stale visual telemetry and preserves the latest frame across cursor updates", () => {
    const frame = {
      mime: "image/png" as const,
      data: "aGVsbG8=",
      hash: "a".repeat(64),
      width: 100,
      height: 50,
      seq: 2,
      at: 2,
    };
    let state = reducer(openComputerState(), {
      type: "computerChild",
      monitor: { ...childMonitor(0, "running"), childId: "child" },
    });
    state = reducer(state, {
      type: "computerChildFrame", childId: "child", seq: 2, at: 2, frame,
    });
    state = reducer(state, {
      type: "computerChildCursor",
      childId: "child",
      seq: 3,
      at: 3,
      cursor: { x: 20, y: 10, seq: 3, at: 3 },
    });
    const current = state.computerChildVisuals.child;
    expect(current).toMatchObject({ lastSeq: 3, frame, cursor: { x: 20, y: 10, seq: 3 } });
    const stale = reducer(state, {
      type: "computerChildCursor",
      childId: "child",
      seq: 1,
      at: 4,
      cursor: { x: 99, y: 49, seq: 1, at: 4 },
    });
    expect(stale).toBe(state);
  });

  it("bounds delegated pixels to the server cap and rejects orphan telemetry", () => {
    let state = openComputerState();
    const frame = {
      mime: "image/png" as const,
      data: "aGVsbG8=",
      hash: "a".repeat(64),
      width: 100,
      height: 50,
      seq: 1,
      at: 1,
    };
    for (let index = 0; index < 20; index += 1) {
      state = reducer(state, { type: "computerChild", monitor: childMonitor(index, "running") });
      state = reducer(state, {
        type: "computerChildFrame",
        childId: `child-${index}`,
        seq: 1,
        at: 1,
        frame,
      });
    }
    expect(Object.keys(state.computerChildVisuals)).toHaveLength(16);
    expect(state.computerChildVisuals["child-0"]).toBeUndefined();
    expect(state.computerChildVisuals["child-19"]?.frame).toEqual(frame);

    const orphan = reducer(state, {
      type: "computerChildFrame",
      childId: "not-a-monitor",
      seq: 1,
      at: 1,
      frame,
    });
    expect(orphan).toBe(state);
  });

  it("removes delegated pixels when bounded monitor history prunes their owner", () => {
    let state = reducer(
      openComputerState(),
      { type: "computerChild", monitor: childMonitor(0) },
    );
    state = reducer(state, {
      type: "computerChildFrame",
      childId: "child-0",
      seq: 1,
      at: 1,
      frame: {
        mime: "image/png",
        data: "aGVsbG8=",
        hash: "a".repeat(64),
        width: 1,
        height: 1,
        seq: 1,
        at: 1,
      },
    });
    for (let index = 1; index <= 128; index += 1) {
      state = reducer(state, { type: "computerChild", monitor: childMonitor(index) });
    }
    expect(state.computerChildren["child-0"]).toBeUndefined();
    expect(state.computerChildVisuals["child-0"]).toBeUndefined();
  });

  it("clears every retained pixel and cursor atomically when the Computer panel closes", () => {
    const monitor = { ...childMonitor(0, "running"), childId: "child" };
    const frame = {
      mime: "image/png" as const,
      data: "aGVsbG8=",
      hash: "a".repeat(64),
      width: 100,
      height: 50,
      seq: 1,
      at: 1,
    };
    let state = reducer(openComputerState(), { type: "computerChild", monitor });
    state = reducer(state, { type: "computerChildFrame", childId: "child", seq: 1, at: 1, frame });
    state = reducer(state, {
      type: "computerChildCursor",
      childId: "child",
      seq: 2,
      at: 2,
      cursor: { x: 25, y: 10, seq: 2, at: 2 },
    });
    state = reducer(state, {
      type: "screenFrame",
      botId: "bot",
      png: "cGl4ZWxz",
      mime: "image/png",
      targetKey: "vm:bot",
      targetGeneration: "generation",
    });

    state = reducer(state, { type: "toggleComputer", open: false });

    expect(state.computerOpen).toBe(false);
    expect(state.screens).toEqual({});
    expect(state.computerChildVisuals).toEqual({});

    // A final frame already queued by the closing EventSource is also denied.
    const afterLateFrame = reducer(state, {
      type: "computerChildFrame",
      childId: "child",
      seq: 3,
      at: 3,
      frame: { ...frame, seq: 3, at: 3 },
    });
    expect(afterLateFrame.computerChildVisuals).toEqual({});
  });

  it("accepts exact delegated visuals from screen-enabled hydration after reopening", () => {
    const monitor = { ...childMonitor(0, "running"), childId: "child" };
    const visual = {
      childId: "child",
      lastSeq: 8,
      frame: {
        mime: "image/png" as const,
        data: "aGVsbG8=",
        hash: "b".repeat(64),
        width: 80,
        height: 40,
        seq: 7,
        at: 7,
      },
      cursor: { x: 12, y: 9, seq: 8, at: 8 },
    };
    let state = reducer(initialState, { type: "toggleComputer", open: true });
    state = reducer(state, {
      type: "hydrate",
      bots: [{ id: "bot" } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [monitor],
      computerChildVisuals: [visual],
    });

    expect(state.computerChildVisuals.child).toEqual(visual);
  });
});

describe("main renderer screen transport", () => {
  it("restores a persisted selected conversation when hydration knows it", () => {
    const next = reducer({ ...initialState, selectedId: "hermes" }, {
      type: "hydrate",
      bots: [{ id: "basil" } as Bot, { id: "hermes" } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [],
      computerChildVisuals: [],
    });
    expect(next.selectedId).toBe("hermes");
  });

  it("falls back when hydration authoritatively lacks a stale selection", () => {
    const next = reducer({ ...initialState, selectedId: "deleted" }, {
      type: "hydrate",
      bots: [{ id: "basil" } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [],
      computerChildVisuals: [],
    });
    expect(next.selectedId).toBe("basil");
  });

  it("upserts a late-created bot without stealing the active conversation", () => {
    const state = { ...initialState, bots: [{ id: "hermes" } as Bot], selectedId: "hermes" };
    const next = reducer(state, { type: "botAdded", bot: { id: "new-bot" } as Bot });
    expect(next.selectedId).toBe("hermes");
    expect(next.bots.map((bot) => bot.id)).toEqual(["new-bot", "hermes"]);
  });

  it("selects an externally-created first bot when no conversation exists", () => {
    const next = reducer({ ...initialState, bots: [], selectedId: "" }, {
      type: "botPatched",
      bot: { id: "first-bot" } as Bot,
    });
    expect(next.selectedId).toBe("first-bot");
  });

  it("atomically rejects delayed navigation after any selection change", () => {
    const started = { ...initialState, bots: [{ id: "basil" } as Bot, { id: "hermes" } as Bot], selectedId: "basil" };
    const epoch = started.selectionEpoch;
    const navigated = reducer(started, { type: "select", id: "hermes" });
    expect(navigated.selectionEpoch).toBe(epoch + 1);
    expect(reducer(navigated, { type: "selectIfUnchanged", id: "basil", selectionEpoch: epoch }).selectedId).toBe("hermes");
  });

  it("folds a stale hydrate without replacing a later selected conversation", () => {
    const started = { ...initialState, bots: [{ id: "basil" } as Bot], selectedId: "basil" };
    const epoch = started.selectionEpoch;
    const navigated = reducer({ ...started, bots: [...started.bots, { id: "hermes" } as Bot] }, { type: "select", id: "hermes" });
    const stale = reducer(navigated, {
      type: "hydrate",
      bots: [{ id: "basil" } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [],
      computerChildVisuals: [],
      selectionEpoch: epoch,
    });
    expect(stale.selectedId).toBe("hermes");
    expect(stale.bots.some((bot) => bot.id === "hermes")).toBe(true);
    expect(stale.hydrationRetryNonce).toBe(navigated.hydrationRetryNonce + 1);

    const reconciled = reducer(stale, {
      type: "hydrate",
      bots: [{ id: "basil" } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [],
      computerChildVisuals: [],
      selectionEpoch: stale.selectionEpoch,
    });
    expect(reconciled.selectedId).toBe("basil");
    expect(reconciled.bots.some((bot) => bot.id === "hermes")).toBe(false);
  });

  it("fences delayed chat navigation after moving to another app view", () => {
    const started = { ...initialState, bots: [{ id: "basil" } as Bot], selectedId: "basil" };
    const epoch = started.selectionEpoch;
    const routines = reducer(started, { type: "showRoutines" });
    expect(routines.selectionEpoch).toBe(epoch + 1);
    const stale = reducer(routines, { type: "selectIfUnchanged", id: "basil", selectionEpoch: epoch });
    expect(stale.activeView).toBe("routines");
  });

  it("does not consume workflow intent when the first imported bot fills an empty app", () => {
    const empty = { ...initialState, selectedId: "", bots: [] };
    const epoch = empty.selectionEpoch;
    const botArrived = reducer(empty, { type: "botAdded", bot: { id: "member" } as Bot });
    expect(botArrived.selectedId).toBe("member");
    expect(botArrived.selectionEpoch).toBe(epoch);
    const room = reducer({ ...botArrived, groups: [{ id: "room" } as Group] }, {
      type: "selectIfUnchanged",
      id: "room",
      selectionEpoch: epoch,
    });
    expect(room.selectedId).toBe("room");
  });

  it("keeps a later non-chat view when the first bot arrives", () => {
    const routines = reducer({ ...initialState, selectedId: "", bots: [] }, { type: "showRoutines" });
    const arrived = reducer(routines, { type: "botAdded", bot: { id: "first" } as Bot });
    expect(arrived.selectedId).toBe("first");
    expect(arrived.activeView).toBe("routines");
    expect(arrived.selectionEpoch).toBe(routines.selectionEpoch);
  });

  it("uses explicit screen-off URLs while hidden and screen-on URLs while visible", () => {
    expect(screenTransportUrl("/api/events", false)).toBe("/api/events?screens=off");
    expect(screenTransportUrl("/api/bots", false)).toBe("/api/bots?screens=off");
    expect(screenTransportUrl("/api/events", true)).toBe("/api/events?screens=on");
    expect(screenTransportUrl("/api/bots", true)).toBe("/api/bots?screens=on");
  });

  it("gates on the panel's real mount condition, including selected-bot presence", () => {
    const visible = openComputerState();
    expect(computerPanelVisible(visible)).toBe(true);
    expect(computerPanelVisible({ ...visible, selectedId: "room" })).toBe(false);
    expect(computerPanelVisible({ ...visible, computerOpen: false })).toBe(false);
  });

  it("cannot retain transcript screenshot pixels after the panel closes", () => {
    let state = reducer(openComputerState(), {
      type: "hydrate",
      bots: [{
        id: "bot",
        threadId: "thread",
        messages: [{ id: "screen", role: "bot", kind: "screen", png: "pixels", mime: "image/png", at: 1 }],
      } as Bot],
      groups: [],
      computerControl: {},
      computerChildren: [],
      computerChildVisuals: [],
    });
    expect(state.bots[0]?.messages[0]?.png).toBe("pixels");

    state = reducer(state, { type: "toggleComputer", open: false });
    expect(state.bots[0]?.messages[0]?.png).toBeUndefined();

    state = reducer(state, {
      type: "messageAdded",
      threadId: "thread",
      message: { id: "late", role: "bot", kind: "screen", png: "late-pixels", mime: "image/png", at: 2 },
    });
    expect(state.bots[0]?.messages.find((message) => message.id === "late")?.png).toBeUndefined();
  });

  it("keeps reconciliation pixel-free and drops queued frames on effect cleanup", () => {
    const source = readFileSync(new URL("./store.tsx", import.meta.url), "utf8");
    expect(source.match(/api\("\/api\/bots\?screens=off"/g)).toHaveLength(2);
    expect(source).toContain("if (!alive) return;");
    expect(source).toContain("pendingFrames.splice(0)");
    expect(source).toContain('tasks?screens=${computerScreensVisible ? "on" : "off"}');
  });
});

describe("bot deletion confirmation", () => {
  it("explains the complete local deletion and fail-closed Box/VPS preflight", () => {
    const copy = botDeletionConfirmation("Scout");

    expect(copy).toContain("Permanently delete Scout?");
    expect(copy).toMatch(/task, message, memory, imported skill, checkpoint/i);
    expect(copy).toMatch(/checks both Box and VPS/i);
    expect(copy).toMatch(/deletion stops.*select and remove/i);
    expect(copy).not.toMatch(/if you do not want it to remain/i);
  });
});

describe("notification routing", () => {
  const bots = [{ id: "bot-1", threadId: "main-thread", tasks: [{ threadId: "detached-thread" }] }] as never;
  const groups = [{ id: "room-1", threadId: "room-thread" }] as never;

  it("selects the bot and switches to the notification's exact task", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "detached-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "bot-1" },
      { type: "switchTask", botId: "bot-1", threadId: "detached-thread" },
    ]);
  });

  it("opens the room when the thread is a group's — never a bot task switch that would 404", () => {
    // room approval/question notifications carry the asker bot with the
    // GROUP's thread id; the exact destination is the room itself
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "room-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "room-1" }]);
  });

  it("lands on a plain bot select for a thread it cannot place, not an error", () => {
    const dispatch = vi.fn();

    openNotificationTarget(dispatch, { botId: "bot-1", threadId: "deleted-task-thread" }, { bots, groups });

    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "bot-1" }]);
  });
});

describe("config status frames", () => {
  it("keeps the room turn timeout with the existing config fields", () => {
    expect(
      configStatusFromFrame({
        xai: { configured: true },
        composio: { configured: true, mode: "managed" },
        box: { configured: false },
        vps: { configured: true, sshAlias: "homelab" },
        rooms: { turnTimeoutMinutes: 20 },
        localVm: { mode: "per-bot", maxInstances: 3 },
        opencodeGo: { configured: true },
        tts: { configured: true, ready: true, voice: "Ada" },
        profile: { name: "Ian", email: "ian@example.test" },
        features: { skillRecorder: true },
      }),
    ).toEqual({
      xai: { configured: true },
      composio: { configured: true, mode: "managed" },
      box: { configured: false },
      vps: { configured: true, sshAlias: "homelab" },
      rooms: { turnTimeoutMinutes: 20 },
      localVm: { mode: "per-bot", maxInstances: 3 },
      opencodeGo: { configured: true },
      tts: { configured: true, ready: true, voice: "Ada" },
      profile: { name: "Ian", email: "ian@example.test" },
      features: { skillRecorder: true },
    });
  });
});

describe("mutually exclusive right-side overlays", () => {
  it("closes every competing overlay when Connected apps opens", () => {
    const layered = {
      ...initialState,
      settingsOpen: true,
      computerOpen: true,
      inspectorOpen: true,
      appSettingsOpen: true,
      pluginsOpen: false,
    };

    const next = reducer(layered, { type: "togglePlugins", open: true });

    expect(next).toMatchObject({
      pluginsOpen: true,
      settingsOpen: false,
      computerOpen: false,
      inspectorOpen: false,
      appSettingsOpen: false,
    });
  });

  it("closes Connected apps when another right-side overlay opens", () => {
    for (const action of [
      { type: "toggleSettings", open: true },
      { type: "toggleComputer", open: true },
      { type: "toggleInspector", open: true },
      { type: "toggleAppSettings", open: true },
    ] as const) {
      expect(reducer({ ...initialState, pluginsOpen: true }, action).pluginsOpen).toBe(false);
    }
  });
});

describe("Auto computer selection", () => {
  const bot = {
    id: "computer-bot",
    threadId: "computer-thread",
    name: "Computer bot",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "model" },
    computer: "vm",
    messages: [],
  } satisfies Bot;

  it("optimistically clears the explicit target without storing the wire-only auto sentinel", () => {
    const next = reducer(
      { ...initialState, bots: [bot], selectedId: bot.id },
      { type: "setComputerAuto", botId: bot.id },
    );

    expect(next.bots[0]?.computer).toBeUndefined();
  });

  it("treats an omitted computer field in a complete bot frame as Auto", () => {
    const { computer: _computer, messages: _messages, ...autoAnnouncement } = bot;
    const next = reducer(
      { ...initialState, bots: [bot], selectedId: bot.id },
      { type: "botPatched", bot: autoAnnouncement },
    );

    expect(next.bots[0]?.computer).toBeUndefined();
  });
});

describe("Teach a skill feature flag", () => {
  const config = configStatusFromFrame({
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: "" },
    rooms: { turnTimeoutMinutes: 5 },
    localVm: { mode: "shared", maxInstances: 2 },
    features: { skillRecorder: true },
  });

  it("does not open the recorder while the experiment is disabled", () => {
    expect(reducer(initialState, { type: "showSkillRecorder" }).activeView).toBe("chat");
  });

  it("opens after opt-in and returns to chat when disabled", () => {
    const enabled = reducer({ ...initialState, config }, { type: "showSkillRecorder" });
    expect(enabled.activeView).toBe("skill-recorder");

    const disabled = reducer(enabled, {
      type: "configStatus",
      config: { ...config, features: { skillRecorder: false } },
    });
    expect(disabled.activeView).toBe("chat");
  });
});

describe("onboarding quiz", () => {
  const quizCard = {
    title: "What do you mostly want help with?",
    subtitle: "Pick whatever's closest; we can always expand from there.",
    options: ["Work & projects"],
  };
  const bot = {
    id: "echo",
    threadId: "t1",
    name: "Echo",
    title: "",
    description: "",
    notifications: true,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "x", model: "y" },
    messages: [
      { id: "g", role: "bot", kind: "text", text: "Hey", at: 1 },
      { id: "q", role: "bot", kind: "options", card: quizCard, at: 2 },
    ],
    activeLeafId: "q",
  } satisfies Bot;

  it("hides the quiz as soon as the person sends a message", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "send", botId: bot.id, text: "Hi bro" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });

  it("hides the quiz when they pick an option", () => {
    const state = { ...initialState, bots: [bot], selectedId: bot.id };
    const next = reducer(state, { type: "answerCard", botId: bot.id, messageId: "q", answer: "Work & projects" });
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card).toMatchObject({
      answered: "Work & projects",
      dismissed: true,
    });
  });

  it("leaves a live permission card in place", () => {
    const askBot: Bot = {
      ...bot,
      messages: [
        ...bot.messages,
        {
          id: "ask",
          role: "bot",
          kind: "options",
          card: {
            title: "Approval needed",
            subtitle: "rm",
            options: ["Allow", "Deny"],
            requestId: "r1",
            tool: "Bash",
          },
          at: 3,
        },
      ],
      activeLeafId: "ask",
    };
    const state = { ...initialState, bots: [askBot], selectedId: askBot.id };
    const next = reducer(state, { type: "send", botId: askBot.id, text: "ok" });
    expect(next.bots[0]?.messages.find((message) => message.id === "ask")?.card?.dismissed).toBeUndefined();
    expect(next.bots[0]?.messages.find((message) => message.id === "q")?.card?.dismissed).toBe(true);
  });
});

describe("cross-client bot creation", () => {
  it("adds an announced bot before its greeting frames arrive", () => {
    const announced = {
      id: "phone-bot",
      threadId: "phone-thread",
      name: "Scout",
      title: "",
      description: "",
      notifications: true,
      color: "green",
      unread: false,
      modelSelection: { instanceId: "codex", model: "default" },
    } satisfies Omit<Bot, "messages">;

    const added = reducer(initialState, { type: "botPatched", bot: announced });

    expect(added.bots).toEqual([{ ...announced, messages: [] }]);

    const greeting = {
      id: "greeting",
      role: "bot",
      kind: "text",
      text: "Hey — I'm Scout. Nice to meet you.",
      at: 2,
    } satisfies Message;
    const greeted = reducer(added, {
      type: "messageAdded",
      threadId: announced.threadId,
      message: greeting,
    });

    expect(greeted.bots[0]?.messages).toEqual([greeting]);
  });
});

describe("section Chiefs", () => {
  const bot = (id: string, section: string, chiefOfStaff = false) => ({
    id,
    threadId: `thread-${id}`,
    name: id,
    title: "",
    description: "",
    notifications: true,
    color: "green" as const,
    unread: false,
    modelSelection: { instanceId: "codex", model: "default" },
    section,
    chiefOfStaff,
  });

  it("hands off only within the patched bot's section", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "botPatched",
      bot: { ...workCandidate, chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });

  it("keeps other section Chiefs during an optimistic settings update", () => {
    const workChief = bot("work-a", "Work", true);
    const workCandidate = bot("work-b", "Work");
    const personalChief = bot("personal", "Personal", true);
    const state = {
      ...initialState,
      bots: [workChief, workCandidate, personalChief].map((candidate) => ({ ...candidate, messages: [] })),
    };

    const next = reducer(state, {
      type: "updateBot",
      botId: workCandidate.id,
      patch: { chiefOfStaff: true },
    });

    expect(next.bots.find((candidate) => candidate.id === workChief.id)?.chiefOfStaff).toBe(false);
    expect(next.bots.find((candidate) => candidate.id === workCandidate.id)?.chiefOfStaff).toBe(true);
    expect(next.bots.find((candidate) => candidate.id === personalChief.id)?.chiefOfStaff).toBe(true);
  });
});

describe("pending queued chip", () => {
  const bot = {
    id: "b1",
    threadId: "t1",
    name: "Ada",
    title: "",
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "acp", model: "fake" },
  } satisfies Omit<Bot, "messages">;

  it("records queue-fallback text and drops it when that user line lands", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q1", text: "later" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("keeps a Shift+Enter multiline message as one entry", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-ml",
      text: "line one\nline two",
    });
    expect(queued.pendingQueued).toEqual({ t1: [{ queueId: "q-ml", text: "line one\nline two" }] });
    const landed = reducer(queued, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-ml",
    });
    expect(landed.pendingQueued).toEqual({});
  });

  it("leaves the chip on the old thread after a task switch", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const queued = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q-stay",
      text: "stay here",
    });
    const switched = reducer(queued, {
      type: "botPatched",
      bot: { ...bot, threadId: "t2", messages: [] },
    });
    expect(switched.pendingQueued).toEqual({ t1: [{ queueId: "q-stay", text: "stay here" }] });
    expect(switched.pendingQueued[switched.bots[0]!.threadId]).toBeUndefined();
    const drained = reducer(switched, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q-stay",
    });
    expect(drained.pendingQueued).toEqual({});
  });

  it("consumes only the matching queue id when two pending lines share text", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const first = reducer(withBot, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qa",
      text: "same",
    });
    const both = reducer(first, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "qb",
      text: "same",
    });
    expect(both.pendingQueued).toEqual({
      t1: [
        { queueId: "qa", text: "same" },
        { queueId: "qb", text: "same" },
      ],
    });
    const afterOther = reducer(both, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "qa",
    });
    expect(afterOther.pendingQueued).toEqual({ t1: [{ queueId: "qb", text: "same" }] });
  });

  it("does not add a chip when the drain frame arrives before the POST continuation", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    const drained = reducer(withBot, {
      type: "consumePendingQueued",
      threadId: "t1",
      queueId: "q1",
    });
    expect(drained.pendingQueued).toEqual({});
    const late = reducer(drained, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "q1",
      text: "later",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds).toEqual({});
  });

  it("bounds unmatched queue tombstones from other clients", () => {
    const withBot = reducer(initialState, { type: "botPatched", bot });
    let state = withBot;
    for (let index = 0; index < 100; index += 1) {
      state = reducer(state, {
        type: "consumePendingQueued",
        threadId: "t1",
        queueId: `foreign-${index}`,
      });
    }

    expect(Object.keys(state.consumedQueueIds)).toHaveLength(64);
    expect(state.consumedQueueIds["foreign-0"]).toBeUndefined();
    expect(state.consumedQueueIds["foreign-99"]).toBe(true);

    const late = reducer(state, {
      type: "pendingQueued",
      threadId: "t1",
      queueId: "foreign-99",
      text: "already drained",
    });
    expect(late.pendingQueued).toEqual({});
    expect(late.consumedQueueIds["foreign-99"]).toBeUndefined();
  });
});
