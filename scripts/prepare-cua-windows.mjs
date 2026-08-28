// Stage the pinned Windows CUA executable, its UI Automation helper, and the
// native SDK outside ASAR. The official release archive is hash-pinned so a
// remote-client build cannot silently ship a different desktop-control binary.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";

if (process.platform !== "win32") throw new Error("prepare-cua-windows must run on Windows");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const release = Object.freeze({
  version: "0.20.0",
  file: "cua-driver-rs-0.20.0-windows-x86_64-binary.zip",
  sha256: "c020fefee01aacc174a27fea84a0cb77d47ef8290bfc772b3db7e3e06670d2b2",
});
const sdkPackage = JSON.parse(await readFile(join(root, "node_modules", "@trycua", "cua-driver", "package.json"), "utf8"));
if (String(sdkPackage.version) !== release.version) {
  throw new Error(`CUA SDK ${sdkPackage.version} does not match pinned Windows driver ${release.version}`);
}

const cache = join(root, "node_modules", ".cache", "openmausbot", `cua-driver-${release.version}-win32-x64`);
const archive = join(cache, release.file);
const extracted = join(cache, "extracted");
const stage = join(root, "dist-native", "win32-x64");

async function validArchive() {
  if (!existsSync(archive)) return false;
  return createHash("sha256").update(await readFile(archive)).digest("hex") === release.sha256;
}

if (!(await validArchive())) {
  await rm(cache, { recursive: true, force: true });
  await mkdir(cache, { recursive: true });
  const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${release.version}/${release.file}`;
  const response = await fetch(url, { headers: { "user-agent": "OpenMausBot-packager" } });
  if (!response.ok) throw new Error(`Windows CUA Driver download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error(`Windows CUA Driver checksum mismatch: expected ${release.sha256}, got ${digest}`);
  }
  await writeFile(archive, bytes);
}

await rm(extracted, { recursive: true, force: true });
await mkdir(extracted, { recursive: true });
await run("tar.exe", ["-xf", archive, "-C", extracted], { timeout: 60_000 });

for (const file of [
  "cua-driver.exe",
  "cua-driver-uia.exe",
  "cua-cursor-theme.exe",
  "cua_driver_sdk.dll",
  "cua_driver_node_runtime.node",
]) {
  if (!existsSync(join(extracted, file))) throw new Error(`Windows CUA archive is missing ${file}`);
}
const { stdout: versionOutput } = await run(join(extracted, "cua-driver.exe"), ["--version"], { timeout: 5_000 });
if (!versionOutput.includes(release.version)) throw new Error(`Windows CUA Driver did not report ${release.version}`);

await rm(stage, { recursive: true, force: true });
await mkdir(join(stage, "cua-sdk", "native"), { recursive: true });
await Promise.all([
  copyFile(join(extracted, "cua-driver.exe"), join(stage, "cua-driver.exe")),
  copyFile(join(extracted, "cua-driver-uia.exe"), join(stage, "cua-driver-uia.exe")),
  copyFile(join(extracted, "cua-cursor-theme.exe"), join(stage, "cua-cursor-theme.exe")),
  copyFile(join(extracted, "cua_driver_sdk.dll"), join(stage, "cua-sdk", "native", "cua_driver_sdk.dll")),
  copyFile(
    join(extracted, "cua_driver_node_runtime.node"),
    join(stage, "cua-sdk", "native", "cua_driver_node_runtime.node"),
  ),
]);

const bundle = join(stage, "cua-sdk", "cua-sdk.mjs");
await build({
  stdin: {
    contents: 'export { EmbeddedCuaDriverHost } from "@trycua/cua-driver/embedded";',
    resolveDir: root,
    sourcefile: "openmausbot-cua-windows-entry.mjs",
    loader: "js",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  banner: {
    js: 'import { createRequire as __openmausbotCreateRequire } from "node:module"; const require = __openmausbotCreateRequire(import.meta.url);',
  },
  outfile: bundle,
  logLevel: "silent",
});
const bundledSource = await readFile(bundle, "utf8");
const resolverPattern = /function resolveLibPath\d*\(opts\) \{/g;
const resolvers = bundledSource.match(resolverPattern) ?? [];
if (resolvers.length !== 1) throw new Error("could not patch the Windows CUA native-library resolver");
await writeFile(
  bundle,
  bundledSource.replace(
    resolverPattern,
    `${resolvers[0]}\n      if (process.env.OPENMAUSBOT_CUA_SDK_LIBRARY) return resolveOverride(opts.crateName, process.env.OPENMAUSBOT_CUA_SDK_LIBRARY);`,
  ),
);

console.log(`Staged Windows x64 CUA Driver ${release.version}`);
