#!/usr/bin/env node
// One source-development generation, one ephemeral UI session.
//
// Starting Vite, the harness, and Electron in separate terminals lets each
// process invent a different bearer. The failure looks like a healthy app
// whose every API request gets a 401. This launcher is the authority owner:
// it creates one token, gives it only to the three local processes, and tears
// the whole generation down when any required process exits.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteEntry = path.join(path.dirname(require.resolve("vite/package.json")), "bin", "vite.js");
const webOnly = process.argv.slice(2).includes("--web-only");
if (webOnly) {
  console.error(
    "[dev] --web-only is disabled: a loopback browser proxy cannot safely hold harness authority from local provider processes. Use `pnpm dev` (Electron).",
  );
  process.exit(2);
}
const sessionToken = randomBytes(32).toString("base64url");
const childEnvironment = {
  ...process.env,
  OMB_UI_SESSION_TOKEN: sessionToken,
};
const viteEnvironment = { ...childEnvironment };
// Electron injects the bearer before Vite proxies the request. Keeping it
// out of Vite prevents any same-host provider from borrowing the dev proxy.
delete viteEnvironment.OMB_UI_SESSION_TOKEN;
delete viteEnvironment.OMB_DEV_BROWSER_SESSION_PROXY;

const prepared = spawnSync(process.execPath, ["scripts/prepare-cloudflared.mjs", "--current"], {
  cwd: root,
  env: childEnvironment,
  stdio: "inherit",
});
if (prepared.status !== 0) process.exit(prepared.status ?? 1);

const processes = [];
const liveProcesses = new Set();
let stopping = false;

function launch(name, executable, args, environment = childEnvironment) {
  const child = spawn(executable, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
    // Own the whole child generation, including Electron/Vite grandchildren,
    // so one Ctrl-C cannot leave ports or provider processes behind.
    detached: process.platform !== "win32",
  });
  processes.push(child);
  liveProcesses.add(child);
  child.once("error", (error) => {
    console.error(`[dev:${name}] ${error.message}`);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    liveProcesses.delete(child);
    if (stopping && liveProcesses.size === 0) process.exit(process.exitCode ?? 0);
    if (stopping) return;
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    console.error(`[dev:${name}] exited with ${reason}; stopping this dev generation`);
    stop(code ?? 1);
  });
  return child;
}

function terminate(child, signal) {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1 || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        stdio: "ignore",
      });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of processes) terminate(child, "SIGTERM");
  if (liveProcesses.size === 0) process.exit(code);
  setTimeout(() => {
    for (const child of processes) terminate(child, "SIGKILL");
    setTimeout(() => process.exit(code), 500).unref();
  }, 5_000);
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

launch("server", process.execPath, ["--experimental-strip-types", "server/index.ts"]);
launch("vite", process.execPath, [viteEntry], viteEnvironment);
launch("electron", require("electron"), ["."]);
