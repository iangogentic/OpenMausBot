// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// The fake is a shebang script — the same constraint codex.cmd itself
// hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

describe("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    opts: { mode?: string; fullAuto?: boolean; environment?: Record<string, string> } = {},
  ) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: opts.environment ?? {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CODEX_TRANSIENTS;
    delete process.env.FAKE_CODEX_PARTIAL_FAILS;
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
      model: "gpt-5.6-sol",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.started", // webSearch OpenMausBot
      "item.completed", // commandExecution done
      "item.completed", // webSearch done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
    });
    expect(recorder.events.filter((event) => event.itemId === "w1")).toMatchObject([
      { type: "item.started", itemType: "tool", title: "web_search" },
      { type: "item.completed", itemType: "tool", ok: true },
    ]);
    // codex reports the THREAD total; the driver turns it into this turn's
    // figure so the harness never sums a running total
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 7, output: 3 } });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // persona rides in front of the prompt text — codex has no system slot
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("You are Testy.\n\nlist files");
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai" });
  });

  it("keeps the full command when a Windows interpreter prefix is long", async () => {
    await create({ mode: "windows-command" });
    await instance.adapter.sendTurn({ threadId: "t-windows-command", text: "read notes" });

    const command = [
      "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "-Command",
      `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
    ].join(" ");
    expect(command.length).toBeGreaterThan(200);
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({
      type: "item.started",
      title: command,
    });
    expect(opened).toMatchObject({ requestType: "permission", summary: command });

    await instance.adapter.respondToRequest("t-windows-command", opened.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("uses the instance environment for the Codex process", async () => {
    const codexHome = join(scratch, "custom-codex-home");
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "environment.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-environment", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.CODEX_HOME).toBe(codexHome);
  });

  it("mounts connected apps without placing credential values in argv", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "check mail",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
            OMB_CONNECTOR_CAPABILITY_TOKEN: "connector-turn-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.openmausbot_connectors.command");
    expect(seen.argv.join(" ")).toContain("OMB_CONNECTOR_CAPABILITY_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("connector-turn-token");
    expect(seen.env.OMB_CONNECTOR_CAPABILITY_TOKEN).toBe("connector-turn-token");
  });

  it("mounts peer-agent comms without placing the comms token in argv", async () => {
    await create();
    const dump = join(scratch, "agents.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "ask the researcher",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            OMB_HARNESS_URL: "http://127.0.0.1:8799",
            OMB_AGENTS_CAPABILITY_TOKEN: "agents-turn-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.agents.command");
    expect(seen.argv.join(" ")).toContain("/tmp/agents-proxy.js");
    expect(seen.argv.join(" ")).toContain("OMB_AGENTS_CAPABILITY_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("agents-turn-token");
    expect(seen.env.OMB_AGENTS_CAPABILITY_TOKEN).toBe("agents-turn-token");
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
  });

  it("keeps peer-agent and connector turn capabilities distinct when both MCPs mount", async () => {
    await create();
    const dump = join(scratch, "combined-capabilities.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-combined-capabilities",
      text: "coordinate and check mail",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            OMB_CONNECTOR_CAPABILITY_TOKEN: "connector-token",
          },
        },
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: {
            OMB_AGENTS_CAPABILITY_TOKEN: "agents-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OMB_CONNECTOR_CAPABILITY_TOKEN).toBe("connector-token");
    expect(seen.env.OMB_AGENTS_CAPABILITY_TOKEN).toBe("agents-token");
    expect(seen.argv.join(" ")).not.toContain("connector-token");
    expect(seen.argv.join(" ")).not.toContain("agents-token");
  });

  it("mounts Ian Brain without placing its exact-turn capability in argv", async () => {
    await create();
    const dump = join(scratch, "ian-brain-capability.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-ian-brain-capability",
      text: "read my wiki",
      integrations: {
        ianBrain: {
          url: "http://127.0.0.1:8799/api/internal/ian-brain/mcp",
          token: "ian-brain-turn-token",
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.ian_brain.command");
    expect(seen.argv.join(" ")).toContain("ian-brain-proxy");
    expect(seen.argv.join(" ")).not.toContain("ian-brain-turn-token");
    expect(seen.env.OMB_IAN_BRAIN_CAPABILITY_TOKEN).toBe("ian-brain-turn-token");
  });

  it("mounts the Local VM computer MCP server without placing credentials in argv", async () => {
    await create();
    const dump = join(scratch, "local-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.computerMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-local-computer",
      text: "open the browser",
      integrations: {
        localComputer: {
          command: process.execPath,
          args: ["/tmp/container-mcp.js", "podman", "openmausbot-computer", "/run/cua.sock"],
          env: { ELECTRON_RUN_AS_NODE: "1", OMB_VM_TOKEN: "vm-secret" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("/tmp/container-mcp.js");
    expect(seen.argv.join(" ")).toContain("OMB_VM_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("vm-secret");
    expect(seen.env.OMB_VM_TOKEN).toBe("vm-secret");
  });

  it("mounts the remote computer proxy without placing its token in argv", async () => {
    await create();
    const dump = join(scratch, "remote-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-remote-computer",
      text: "take a screenshot",
      integrations: {
        computer: {
          boxId: "box-123",
          broker: { url: "http://127.0.0.1:8799/api/internal/box", token: "turn-capability" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("computer-proxy");
    expect(seen.argv.join(" ")).toContain("OMB_BOX_CAPABILITY_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("turn-capability");
    expect(seen.env.OGB_BOX_ID).toBe("box-123");
    expect(seen.env.OMB_BOX_CAPABILITY_TOKEN).toBe("turn-capability");
    expect(seen.env.OGB_BOX_TOKEN).toBeUndefined();
  });

  it("clears inherited MCP servers before mounting the dedicated operator", async () => {
    await create();
    const dump = join(scratch, "operator.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-operator",
      text: "delegate",
      integrations: {
        computerOperator: {
          command: process.execPath,
          args: ["/tmp/computer-operator.js"],
          env: { OMB_COMPUTER_OPERATOR_CAPABILITY_TOKEN: "operator-token" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const clearAt = seen.argv.indexOf("mcp_servers={}");
    const operatorAt = seen.argv.findIndex((arg: string) => arg.includes("mcp_servers.computer_operator.command"));
    expect(clearAt).toBeGreaterThan(-1);
    expect(operatorAt).toBeGreaterThan(clearAt);
    expect(seen.argv.join(" ")).not.toContain("mcp_servers.computer.command");
  });

  it("sends the local provider when the picker id is custom-encoded", async () => {
    await create({ environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" } });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "hi",
      model: "unsloth::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const threadStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "unsloth",
    });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("model_providers.unsloth.base_url=\"http://127.0.0.1:8888/v1\"");
    expect(JSON.stringify(seen.argv)).not.toContain("unsloth-secret");
    // Upstream host credentials are reserved from provider children. Direct
    // adapter callers get the non-secret local fallback; production dispatch
    // always supplies the exact-turn model relay below.
    expect(seen.env.OPENMAUSBOT_LOCAL_UNSLOTH_API_KEY).toBe("local");
  });

  it("routes local models through an exact-turn relay without exposing the upstream source", async () => {
    await create({
      environment: {
        UNSLOTH_STUDIO_AUTH_TOKEN: "real-upstream-secret",
        OPENMAUSBOT_DESKTOP2_QWEN_URL: "http://127.0.0.1:18011/v1",
      },
    });
    const dump = join(scratch, "relay.json");
    process.env.FAKE_CODEX_DUMP = dump;
    const relay = {
      openaiBaseUrl: "http://10.0.2.2:8799/api/internal/model-relay/v1",
      anthropicBaseUrl: "http://10.0.2.2:8799/api/internal/model-relay",
      token: "opaque-exact-turn-model-token-123456",
      host: "desktop2_qwen",
      model: "Qwen3.8-27B-Abliterated",
    };
    await instance.adapter.sendTurn({
      threadId: "t-local-relay",
      text: "hi",
      model: "desktop2_qwen::Qwen3.8-27B-Abliterated",
      integrations: { modelRelay: relay },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const threadStart = seen.calls.find((call: { method: string }) => call.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: relay.model,
      modelProvider: "openmaus_desktop2_qwen",
    });
    expect(JSON.stringify(seen)).toContain(relay.openaiBaseUrl);
    expect(JSON.stringify(seen)).toContain(relay.token);
    expect(JSON.stringify(seen)).not.toContain("http://127.0.0.1:18011/v1");
    expect(JSON.stringify(seen)).not.toContain("real-upstream-secret");
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("falls back to a fresh thread when resume fails", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    await instance.adapter.sendTurn({ threadId: "t-fallback", text: "go", resumeCursor: "gone-thread" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1" });
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("answers Codex 0.149 MCP elicitation with the MCP result shape", async () => {
    await create({ mode: "mcp-elicitation" });
    const dump = join(scratch, "mcp-elicitation.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-elicitation", text: "list bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "list_bots",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });

    await instance.adapter.respondToRequest("t-mcp-elicitation", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: {} });
  });

  it("stamps approvalScope on cards only when the turn controls this Mac", async () => {
    await create({ mode: "approval" });

    // host-mounted: every card carries the scope that prevents a remembered
    // grant from leaking into VM/cloud tools.
    await instance.adapter.sendTurn({
      threadId: "t-host-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });
    const host = await recorder.until((e) => e.type === "request.opened");
    expect(host).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-host-scope", host.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    // a Local VM mount is not the host: no scope stamped
    await instance.adapter.sendTurn({
      threadId: "t-vm-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: process.execPath, args: ["/tmp/container-mcp.js"], env: {} },
      },
    });
    const vm = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-vm-scope");
    expect((vm as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-vm-scope", vm.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-vm-scope");
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("never lets fullAuto bypass a physical-computer approval", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "full-auto-host-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-auto-host",
      text: "inspect the Mac",
      integrations: {
        localComputer: {
          command: "/cua-driver",
          args: ["mcp"],
          env: {},
          platform: "darwin",
          scope: "local-computer",
        },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-auto-host", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    const threadStart = JSON.parse(readFileSync(dump, "utf8")).calls.find(
      (call: { method: string }) => call.method === "thread/start",
    );
    expect(threadStart.params).toMatchObject({ sandbox: "workspace-write", approvalPolicy: "on-request" });
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("reports whether the installed Codex CLI is signed in", async () => {
    await create();
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });

    await instance.dispose();
    recorder.stop();
    await create({ mode: "logged-out" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
    });
  });

  it("also accepts login status from older Codex versions that used stdout", async () => {
    await create({ mode: "logged-in-stdout" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });
  });

  it("marks a Codex 401 as setup so the UI offers sign-in instead of Retry", async () => {
    await create({ mode: "unauthorized" });
    await instance.adapter.sendTurn({ threadId: "t-unauthorized", text: "hi" });

    const error = await recorder.until((event) => event.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });

  it("auto-retries a transient turn/start failure, then completes with one final message", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-retry", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    // exactly one settled reply across all three app-server launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("stops retrying at the attempt cap and settles as failed", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-cap");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-cap", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
  }, 20_000);

  it("interrupting one thread does not cancel another thread's retry", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-concurrent");
    await create();

    const first = instance.adapter.sendTurn({ threadId: "t-codex-stop", text: "stop me" });
    const second = instance.adapter.sendTurn({ threadId: "t-codex-continue", text: "keep going" });
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-stop");
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-continue");
    await instance.adapter.interruptTurn("t-codex-stop");

    await expect(
      recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-codex-continue"),
    ).resolves.toMatchObject({ ok: true });
    await Promise.allSettled([first, second]);
  }, 20_000);

  it("drains a cancelled retry before admitting a successor on the same thread", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-stop-drain");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.2";
    await create();

    const threadId = "t-codex-stop-drain";
    await instance.adapter.sendTurn({ threadId, turnId: "retired-generation", text: "retry, then stop" });
    const retry = await recorder.until(
      (event) => event.type === "turn.retrying" && event.threadId === threadId,
    );
    const retiredBackoffMs = retry.type === "turn.retrying" ? retry.delayMs : 1_000;

    // Stop must cancel the pending delay, settle the retired handle, and only
    // then return. Otherwise this immediate successor is rejected as busy and
    // the old timer can later erase its active-map entry.
    await instance.adapter.interruptTurn(threadId);
    expect(instance.adapter.hasSession(threadId)).toBe(false);
    expect(recorder.events.filter(
      (event) => event.type === "turn.completed" && event.turnId === "retired-generation",
    )).toHaveLength(1);

    process.env.FAKE_CODEX_MODE = "approval";
    await instance.adapter.sendTurn({ threadId, turnId: "successor-generation", text: "stay active" });
    const opened = await recorder.until(
      (event) => event.type === "request.opened" && event.turnId === "successor-generation",
    );

    // Wait beyond the retired generation's original scaled backoff. Its late
    // continuation must neither relaunch nor delete the successor handle.
    await new Promise((resolve) => setTimeout(
      resolve,
      Math.ceil(retiredBackoffMs * 0.2) + 100,
    ));
    expect(instance.adapter.hasSession(threadId)).toBe(true);
    await expect(
      instance.adapter.respondToRequest(threadId, opened.requestId!, { behavior: "allow" }),
    ).resolves.toBe("allowed-once");
    await expect(recorder.until(
      (event) => event.type === "turn.completed" && event.turnId === "successor-generation",
    )).resolves.toMatchObject({ ok: true });
  }, 20_000);

  it("never retries after agent text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_PARTIAL_FAILS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-partial");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-partial", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);


  it("uses the explicit login command from the official Codex flow", () => {
    expect(CodexDriver.install?.signInCommand).toBe("codex login");
  });

  it("declares the effort levels the app-server accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("sends effort on turn/start, and omits the key when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.effort).toBe("xhigh");
  });

  it("sends no effort key when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params).not.toHaveProperty("effort");
  });
});
