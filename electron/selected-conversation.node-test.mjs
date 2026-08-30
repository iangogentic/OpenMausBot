import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  normalizeSelectedConversation,
  readSelectedConversation,
  writeSelectedConversation,
} from "./selected-conversation.mjs";

test("persists one bounded opaque conversation id with private permissions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-selection-"));
  const file = path.join(root, "nested", "selected-conversation");
  try {
    assert.equal(writeSelectedConversation(file, "  hermes_qwen-1  "), true);
    assert.equal(readSelectedConversation(file), "hermes_qwen-1");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects traversal, controls, whitespace and oversized ids", () => {
  for (const value of ["", "../bot", "bot id", "bot\nnext", "x".repeat(129)]) {
    assert.equal(normalizeSelectedConversation(value), "");
  }
});

test("a missing or malformed preference reads as no selection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-selection-"));
  const file = path.join(root, "selected-conversation");
  try {
    assert.equal(readSelectedConversation(file), "");
    fs.writeFileSync(file, "../../foreign\n");
    assert.equal(readSelectedConversation(file), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an empty selection clears the durable preference but invalid input does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omb-selection-"));
  const file = path.join(root, "selected-conversation");
  try {
    assert.equal(writeSelectedConversation(file, "hermes"), true);
    assert.equal(writeSelectedConversation(file, "../bot"), false);
    assert.equal(readSelectedConversation(file), "hermes");
    assert.equal(writeSelectedConversation(file, "   "), true);
    assert.equal(readSelectedConversation(file), "");
    assert.equal(fs.existsSync(file), false);
    assert.equal(writeSelectedConversation(file, ""), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
