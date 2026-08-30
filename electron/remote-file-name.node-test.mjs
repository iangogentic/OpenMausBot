import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { remoteDownloadName } = require("./remote-file-name.cjs");

test("round-trips emoji and CJK download hints", () => {
  const name = "报告-📄.bin";
  assert.equal(remoteDownloadName(Buffer.from(name, "utf8").toString("base64url")), name);
});

test("rejects malformed UTF-8, traversal, controls, and oversized metadata", () => {
  assert.equal(remoteDownloadName("_w"), "attachment");
  assert.equal(remoteDownloadName(Buffer.from("../secret", "utf8").toString("base64url")), "attachment");
  assert.equal(remoteDownloadName(Buffer.from("bad\nname", "utf8").toString("base64url")), "attachment");
  assert.equal(remoteDownloadName("a".repeat(1369)), "attachment");
});

test("accepts a safe legacy ASCII hint only as an upgrade fallback", () => {
  assert.equal(remoteDownloadName(null, "report.pdf"), "report.pdf");
  assert.equal(remoteDownloadName(null, "../report.pdf"), "attachment");
});
