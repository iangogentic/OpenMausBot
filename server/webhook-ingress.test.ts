import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { listenWebhookIngress, MAX_WEBHOOK_BODY_BYTES, webhookCredential, type WebhookIngress } from "./webhook-ingress.ts";
import { WebhookManager } from "./webhooks.ts";

let dir: string;
let ingress: WebhookIngress;
let endpointId: string;
let secret: string;
let manager: WebhookManager;
const queued: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "omb-webhook-ingress-"));
  manager = new WebhookManager({
    file: join(dir, "webhooks.json"),
    botState: () => "ready",
    enqueue: (input) => {
      queued.push(input);
      return { id: `run-${queued.length}` };
    },
  });
  const created = manager.create({ name: "Build event", prompt: "Review the build", botId: "maus-1" });
  endpointId = created.webhook.endpointId;
  secret = created.secret;
  ingress = await listenWebhookIngress(manager, { port: 0 });
});

afterAll(async () => {
  await new Promise<void>((resolve) => ingress.server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

describe("webhook-only ingress", () => {
  it("exposes health but nothing from the main OpenMausBot API", async () => {
    const health = await fetch(`${ingress.baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ app: "openmausbot-webhooks", ready: true });
    expect((await fetch(`${ingress.baseUrl}/api/bots`)).status).toBe(404);
  });

  it("accepts capability URLs and deduplicates retries", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "delivery-1", "x-github-event": "push" },
      body: JSON.stringify({ ref: "main", id: "event-in-body" }),
    });
    const first = await send();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ accepted: true, duplicate: false, runId: "run-1" });
    const retry = await send();
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ accepted: true, duplicate: true, runId: "run-1" });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.prompt).toContain("Event: push");
  });

  it("also accepts a bearer secret without putting it in the URL", async () => {
    const response = await fetch(`${ingress.baseUrl}/hooks/${endpointId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/x-www-form-urlencoded" },
      body: "ticket=42&priority=high",
    });
    expect(response.status).toBe(202);
    expect(queued.at(-1)?.prompt).toContain('"ticket": "42"');
  });

  it("does not deduplicate separate requests that reuse a generic payload id", async () => {
    const credential = webhookCredential(ingress.baseUrl, endpointId, secret);
    const before = queued.length;
    const send = () => fetch(credential.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "shared-record", task: "Handle this update" }),
    });
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(202);
    expect(queued).toHaveLength(before + 2);
  });

  it("captures a verification event without queueing work", async () => {
    const created = manager.create({ name: "Verify", prompt: "", botId: "maus-1", enabled: false, verificationPending: true });
    const before = queued.length;
    const response = await fetch(webhookCredential(ingress.baseUrl, created.webhook.endpointId, created.secret).url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-event": "support.created" },
      body: JSON.stringify({ task: "Triage ticket 42" }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, captured: true });
    expect(queued).toHaveLength(before);
    expect(manager.list().find((webhook) => webhook.id === created.webhook.id)).toMatchObject({ verificationPending: false, enabled: false });
  });

  it("rejects invalid credentials, malformed JSON and oversized bodies", async () => {
    const unauthorized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/wrong`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${ingress.baseUrl}/hooks/${endpointId}/${secret}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(manager.listAttempts().filter((attempt) => attempt.webhookId === manager.list().find((webhook) => webhook.endpointId === endpointId)?.id && attempt.outcome === "rejected").length).toBeGreaterThanOrEqual(3);
  });
});

describe.runIf(process.platform !== "win32")("webhook deployment socket", () => {
  it("binds a private UDS while reporting the persistent public port", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmaus-webhook-"));
    chmodSync(directory, 0o700);
    const socketPath = join(directory, "webhook.sock");
    const isolatedManager = new WebhookManager({
      file: join(directory, "webhooks.json"),
      botState: () => "ready",
      enqueue: () => ({ id: "run-uds" }),
    });
    let isolated: WebhookIngress | undefined;
    try {
      isolated = await listenWebhookIngress(isolatedManager, {
        host: "127.0.0.1",
        port: 8800,
        socketPath,
      });
      expect(isolated.baseUrl).toBe("http://127.0.0.1:8800");
      expect(isolated.port).toBe(8800);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);
      const health = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const outgoing = request({ socketPath, path: "/health" }, (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => resolve({
            status: incoming.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }));
        });
        outgoing.once("error", reject);
        outgoing.end();
      });
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ app: "openmausbot-webhooks", ready: true });
    } finally {
      if (isolated) await new Promise<void>((resolve) => isolated!.server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a relative socket instead of falling back to TCP", async () => {
    const isolatedManager = new WebhookManager({
      botState: () => "ready",
      enqueue: () => ({ id: "run-invalid" }),
    });
    await expect(listenWebhookIngress(isolatedManager, {
      port: 8800,
      socketPath: "webhook.sock",
    })).rejects.toThrow("absolute Unix-socket path");
  });
});
