import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { companionChildEnvironment, companionSessionMessage } = require("./companion-launch.cjs");

test("the companion startup environment never contains either app bearer", async () => {
  const secret = `session-${"s".repeat(43)}`;
  const companionSecret = `companion-${"c".repeat(43)}`;
  const env = companionChildEnvironment(
    {
      ...process.env,
      OMB_UI_SESSION_TOKEN: secret,
      OMB_COMPANION_SESSION_TOKEN: companionSecret,
    },
    { socketPath: "/tmp/openmaus-test.sock", harnessPort: 8799, companionPort: 8810, controlPort: 8811 },
  );
  assert.equal(env.OMB_UI_SESSION_TOKEN, undefined);
  assert.equal(env.OMB_COMPANION_SESSION_TOKEN, undefined);

  const child = spawn(process.execPath, ["-e", String.raw`
    const fs = require("node:fs");
    const startup = fs.existsSync("/proc/self/environ") ? fs.readFileSync("/proc/self/environ", "utf8") : "";
    process.stdout.write(JSON.stringify({
      ui: process.env.OMB_UI_SESSION_TOKEN || null,
      companion: process.env.OMB_COMPANION_SESSION_TOKEN || null,
      startup,
    }));
  `], { env, stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  const observed = JSON.parse(output);
  assert.equal(observed.ui, null);
  assert.equal(observed.companion, null);
  assert.equal(observed.startup.includes(secret), false);
  assert.equal(observed.startup.includes(companionSecret), false);
});

test("distinct bearers are carried only by the private parent message", () => {
  const harness = "h".repeat(43);
  const control = "c".repeat(43);
  assert.deepEqual(companionSessionMessage(harness, control), {
    type: "openmausbot:companion-sessions",
    harnessSessionToken: harness,
    controlSessionToken: control,
  });
});
