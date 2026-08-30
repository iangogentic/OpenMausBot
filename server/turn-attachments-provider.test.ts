import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "omb-provider-attachment-e2e-")));
const RUNTIME_ROOT = join(ROOT, "runtime");
const PROVIDER_ROOT = join(ROOT, "provider-home");
const PROVIDER_HOME = join(PROVIDER_ROOT, "instances", "driver", "instance");
const PROVIDER_STATE_ROOT = join(PROVIDER_ROOT, "state");
const PROVIDER_STATE = join(PROVIDER_STATE_ROOT, "driver", "instance");
mkdirSync(RUNTIME_ROOT, { recursive: true, mode: 0o750 });
mkdirSync(PROVIDER_HOME, { recursive: true, mode: 0o2750 });
mkdirSync(PROVIDER_STATE, { recursive: true, mode: 0o750 });
chmodSync(RUNTIME_ROOT, 0o750);
chmodSync(PROVIDER_HOME, 0o2750);
chmodSync(PROVIDER_STATE_ROOT, 0o750);
chmodSync(PROVIDER_STATE, 0o750);
process.env.OMB_DATA_DIR = join(ROOT, "data");
process.env.OMB_PROVIDER_RUNTIME_DIR = RUNTIME_ROOT;

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
chmodSync(FAKE_CLI, 0o755);

const { saveUploadedFile } = await import("./attachments.ts");
const { stageTurnAttachments } = await import("./turn-attachments.ts");
const { prepareProviderSandboxEnvironment } = await import("./procs.ts");
const { GeminiAgentDriver } = await import("./drivers/acp/gemini.ts");

afterAll(() => {
  delete process.env.FAKE_ACP_MODE;
  rmSync(ROOT, { recursive: true, force: true });
});

describe("managed attachment → isolated ACP provider", () => {
  it("mounts only the exact handoff and the provider reads exact binary bytes", async () => {
    const payload = Buffer.from([0, 0xff, 1, 2, 3, 0x80, 0x0a]);
    const saved = saveUploadedFile(payload, "payload.bin");
    const handoff = stageTurnAttachments([`analyze this\n\n<attached-file path="${saved.path}" />`]);
    expect(handoff.providerRuntimePaths).toHaveLength(1);
    expect(handoff.texts[0]).not.toContain(saved.path);

    // This is the manifest the root supervisor consumes in production. The
    // broad upload store must be absent; only this turn's read-only handoff
    // directory and the supervisor's own private spawn directory are named.
    const prepared = prepareProviderSandboxEnvironment(
      {
        OMB_PROVIDER_INSTANCE_HOME: realpathSync(PROVIDER_HOME),
        OMB_PROVIDER_INSTANCE_STATE: realpathSync(PROVIDER_STATE),
      },
      handoff.providerRuntimePaths,
      {
        ...process.env,
        OMB_PROVIDER_RUNTIME_DIR: realpathSync(RUNTIME_ROOT),
        OMB_PROVIDER_HOME: realpathSync(PROVIDER_ROOT),
        OMB_PROVIDER_STATE_DIR: realpathSync(PROVIDER_STATE_ROOT),
      },
    );
    const manifest = JSON.parse(readFileSync(prepared.manifestPath, "utf8")) as {
      paths: Array<{ path: string; writable: boolean }>;
    };
    expect(manifest.paths).toContainEqual({ path: handoff.providerRuntimePaths[0]!.path, writable: false });
    expect(JSON.stringify(manifest.paths)).not.toContain("uploaded-files");
    prepared.cleanup();

    process.env.FAKE_ACP_MODE = "read-attachment";
    const instance = await GeminiAgentDriver.create({
      instanceId: "attachment-e2e",
      displayName: "Attachment E2E",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const events: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      instance.adapter.onEvent((event) => {
        events.push(event);
        if (event.type === "turn.completed") resolve();
      });
    });
    await instance.adapter.sendTurn({
      threadId: "attachment-e2e-thread",
      text: handoff.texts[0]!,
      providerRuntimePaths: handoff.providerRuntimePaths,
    });
    await done;
    expect(events).toContainEqual(expect.objectContaining({
      type: "item.completed",
      itemType: "assistant_text",
      text: `attachment-base64:${payload.toString("base64")}`,
    }));

    await instance.dispose();
    const stagedPath = handoff.staged[0]!.stagedPath;
    handoff.cleanup();
    expect(() => readFileSync(stagedPath)).toThrow();
  });
});
