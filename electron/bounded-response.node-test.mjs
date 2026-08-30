import assert from "node:assert/strict";
import test from "node:test";

import {
  readBoundedResponseBytes,
  readBoundedResponseJson,
  readBoundedResponseText,
} from "./bounded-response.mjs";

test("bounded Electron response reading cancels a streaming peer at the cap", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(Buffer.alloc(6, 0x61));
      if (pulls > 5) controller.close();
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    readBoundedResponseBytes(new Response(body), 10, "too large"),
    /too large/,
  );
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test("bounded Electron response reading rejects dishonest lengths and invalid UTF-8", async () => {
  let cancelled = false;
  const declared = new ReadableStream({
    pull(controller) { controller.enqueue(Buffer.from("small")); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(
    readBoundedResponseText(
      new Response(declared, { headers: { "content-length": "not-a-number" } }),
      10,
      "too large",
    ),
    /too large/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    readBoundedResponseText(new Response(Uint8Array.from([0xc3, 0x28])), 10, "too large"),
    /not valid UTF-8/,
  );
});

test("bounded Electron response JSON returns only a fully bounded valid document", async () => {
  assert.deepEqual(
    await readBoundedResponseJson(new Response('{"ok":true}'), 64, "too large"),
    { ok: true },
  );
  await assert.rejects(
    readBoundedResponseJson(new Response("{"), 64, "too large"),
    SyntaxError,
  );
});
