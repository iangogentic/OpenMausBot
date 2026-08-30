#!/usr/bin/env node
// Cross-platform manifest for every plain-Node Electron boundary test.
// Shell globs are not portable to Windows, while an explicit hand-maintained
// list silently stops protecting any new security suite added later.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const files = readdirSync("electron")
  .filter((name) => name.endsWith(".node-test.mjs"))
  .sort()
  .map((name) => path.join("electron", name));

if (files.length === 0) {
  console.error("No Electron node tests were discovered");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
