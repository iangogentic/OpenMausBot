import { describe, expect, it } from "vitest";

import { appCommands, matchingAppCommands } from "./app-commands";
import { initialState } from "@/state/store";

describe("app commands", () => {
  it("disables bot-scoped commands without inventing a target", () => {
    const commands = appCommands(initialState);
    expect(commands.find((command) => command.id === "new-task")).toMatchObject({
      enabled: false,
      disabledReason: "Select a bot first",
      action: { type: "newTask", botId: "" },
    });
    expect(commands.find((command) => command.id === "new-bot")?.enabled).toBe(true);
  });

  it("matches names before descriptions and keywords", () => {
    const commands = appCommands(initialState);
    expect(matchingAppCommands(commands, "engine").map((command) => command.id)[0]).toBe("engines");
    expect(matchingAppCommands(commands, "schedule").map((command) => command.id)).toEqual(["routines"]);
    expect(matchingAppCommands(commands, "desktop").map((command) => command.id)).toContain("computer");
  });
});
