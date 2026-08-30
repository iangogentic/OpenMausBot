import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

describe("cloud computer lifecycle", () => {
  let api: Server;
  let sleepBox: typeof import("./box.ts").sleepBox;
  let acquireBoxCredentialUse: typeof import("./box.ts").acquireBoxCredentialUse;
  let beginBoxCredentialMutation: typeof import("./box.ts").beginBoxCredentialMutation;
  let deleteBox: typeof import("./box.ts").deleteBox;
  const requests: Array<{
    method: string;
    path: string;
    command?: string;
    headers: IncomingMessage["headers"];
  }> = [];
  const botId = "browser-session-test";
  let state = "ready";
  let stopStatus = 200;
  let archiveOnStop = true;

  beforeAll(async () => {
    const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
    const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "");
    const machineName = `ogb-${prefix}-${hash}`;
    api = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://box.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        requests.push({ method: req.method ?? "GET", path: url.pathname, command: parsed.command, headers: req.headers });
        if (req.method === "DELETE" && url.pathname.endsWith("/boxes/box-1")) {
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, operationId: "delete-operation-1" }));
          return;
        }
        if (url.pathname.endsWith("/stop")) {
          res.writeHead(stopStatus, { "content-type": "application/json" });
          if (stopStatus >= 200 && stopStatus < 300 && archiveOnStop) state = "archived";
          res.end(JSON.stringify(stopStatus >= 400 ? { message: "provider refused stop" } : { ok: true }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (url.pathname === "/api/box/v1/boxes") {
          res.end(JSON.stringify({ boxes: [{ id: "box-1", name: machineName, state }] }));
        } else if (url.pathname.endsWith("/boxes/box-1")) {
          res.end(JSON.stringify({ ok: true, box: { id: "box-1", name: machineName, state } }));
        } else if (url.pathname.endsWith("/commands")) {
          res.end(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
      });
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const port = (api.address() as any).port;
    vi.stubEnv("OMB_BOX_API", `http://127.0.0.1:${port}/api/box/v1`);
    vi.resetModules();
    ({ sleepBox, deleteBox, acquireBoxCredentialUse, beginBoxCredentialMutation } = await import("./box.ts"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });

  it("asks Chrome to exit before archiving the computer", async () => {
    state = "ready";
    stopStatus = 200;
    archiveOnStop = true;
    await sleepBox({ box: { token: "box_test" } } as any, botId);

    const commandIndex = requests.findIndex((request) => request.path.endsWith("/commands"));
    const stopIndex = requests.findIndex((request) => request.path.endsWith("/stop"));
    expect(commandIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(commandIndex);
    expect(requests[commandIndex]?.command).toContain("kill -TERM");
    expect(requests[commandIndex]?.command).toContain("pgrep -o -x");
  });

  it("rejects a provider stop failure instead of claiming reset proof", async () => {
    state = "ready";
    stopStatus = 500;
    archiveOnStop = false;
    await expect(sleepBox({ box: { token: "box_test" } } as any, botId, 100)).rejects.toThrow(/stop.*failed/i);
  });

  it("rejects an unverified stop timeout", async () => {
    state = "ready";
    stopStatus = 200;
    archiveOnStop = false;
    await expect(sleepBox({ box: { token: "box_test" } } as any, botId, 100)).rejects.toThrow(/not verified/i);
  });

  it("permanently deletes the exact Box with the provider confirmation header", async () => {
    state = "ready";
    requests.length = 0;

    const result = await deleteBox({ box: { token: "box_test" } } as any, botId);

    expect(result).toEqual({ ok: true, deleted: true, missing: false, pending: true });
    const removal = requests.find((request) => request.method === "DELETE");
    expect(removal?.path).toBe("/api/box/v1/boxes/box-1");
    expect(removal?.headers["x-ascii-confirm-delete"]).toBe("box-1");
    expect(JSON.stringify(result)).not.toContain("box_test");
    expect(JSON.stringify(result)).not.toContain("delete-operation-1");
  });

  it("pins token A while a paused operation blocks rotation to token B", () => {
    const liveConfig = { box: { token: "box_a" } } as any;
    const operation = acquireBoxCredentialUse(liveConfig);
    liveConfig.box.token = "box_b";

    expect(operation.config.box?.token).toBe("box_a");
    expect(beginBoxCredentialMutation("box_a", "box_b")).toMatchObject({
      allowed: false,
    });

    operation.release();
    const mutation = beginBoxCredentialMutation("box_a", "box_b");
    expect(mutation).toMatchObject({ allowed: true, changing: true });
    expect(() => acquireBoxCredentialUse(liveConfig)).toThrow(/settings are being updated/i);
    if (mutation.allowed) mutation.release();
  });
});
