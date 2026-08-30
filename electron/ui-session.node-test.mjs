import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { uiSessionRequestHeaders } = require("./ui-session.cjs");
const origin = "http://127.0.0.1:8799";
const secret = "s".repeat(43);

test("injects the app bearer only for the exact harness origin", () => {
  assert.equal(
    uiSessionRequestHeaders(origin, secret, `${origin}/api/bots`, {})["X-OpenMausBot-Session"],
    secret,
  );
  assert.equal(
    uiSessionRequestHeaders(origin, secret, "http://127.0.0.1:9999/steal", {})["X-OpenMausBot-Session"],
    undefined,
  );
  assert.equal(
    uiSessionRequestHeaders(origin, secret, "https://example.test/image.png", {})["X-OpenMausBot-Session"],
    undefined,
  );
});

test("strips renderer-supplied bearer headers outside the harness", () => {
  const headers = uiSessionRequestHeaders(origin, secret, "http://127.0.0.1:9999/steal", {
    "x-openmausbot-session": "attacker-choice",
    Accept: "image/*",
  });
  assert.deepEqual(headers, { Accept: "image/*" });
});

test("builds authenticated headers for a main-process credential config request", () => {
  const headers = uiSessionRequestHeaders(origin, secret, `${origin}/api/config`, {
    "content-type": "application/json",
  });
  assert.deepEqual(headers, {
    "content-type": "application/json",
    "X-OpenMausBot-Session": secret,
  });
});
