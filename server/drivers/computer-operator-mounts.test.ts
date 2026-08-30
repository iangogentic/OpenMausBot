import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { SendTurnInput } from "../contracts.ts";
import { antigravityComputerMcpServer } from "./antigravity.ts";
import { buildMcpServers } from "./pi.ts";

const operator = {
  command: "/usr/bin/node",
  args: ["computer-operator-proxy.js"],
  env: { OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN: "exact-turn-token" },
};
const direct = { command: "/opt/cua", args: ["mcp"], env: { DIRECT: "must-not-mount" } };

function turn(): SendTurnInput {
  return {
    threadId: "thread",
    text: "delegate",
    integrations: { computerOperator: operator, localComputer: direct },
  };
}

describe("dedicated computer operator mounts", () => {
  it("Pi mounts only the operator when a direct computer is also supplied", () => {
    expect(buildMcpServers(turn())).toEqual({ computer_operator: operator });
  });

  it("Antigravity gives the operator strict precedence over direct computer tools", () => {
    expect(antigravityComputerMcpServer(turn().integrations)).toEqual(operator);
  });

  it.each([
    ["claude.ts", "mcpServers.computer_operator = { ...turn.integrations.computerOperator }"],
    ["codex.ts", 'mountMcpServer(appServerArgs, env, "computer_operator", turn.integrations.computerOperator)'],
    ["pi.ts", "servers.computer_operator = { ...turn.integrations.computerOperator }"],
    ["antigravity.ts", "computerOperatorMcp: config.fullAuto"],
  ])("%s advertises or mounts the dedicated operator", (file, statement) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(source).toContain(statement);
    expect(source).toContain("computerOperatorMcp:");
  });
});
