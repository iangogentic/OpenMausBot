import assert from "node:assert/strict";
import test from "node:test";

import approvalDialog from "./physical-approval-dialog.cjs";

test("physical approval names the exact bot and task and explains Always Allow scope", () => {
  const signal = new AbortController().signal;
  const options = approvalDialog.physicalApprovalDialogOptions({
    deviceName: "Mac",
    botId: "bot-7",
    botLabel: "Research Cat",
    taskLabel: "Audit browser handoff",
    sessionId: "12345678-0000-4000-8000-000000000001",
    signal,
  });

  assert.match(options.message, /Research Cat/);
  assert.match(options.detail, /Task: Audit browser handoff/);
  assert.match(options.detail, /Bot bot-7; session 12345678/);
  assert.match(options.detail, /all future physical-computer connection prompts while this app stays open/);
  assert.match(options.detail, /Every action still passes the server's control and human-takeover gates/);
  assert.deepEqual(options.buttons, ["Deny", "Allow Once", "Always Allow While App Is Open"]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(options.signal, signal);
});
