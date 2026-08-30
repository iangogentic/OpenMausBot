"use strict";

function physicalApprovalDialogOptions({
  deviceName,
  botId,
  botLabel,
  taskLabel,
  sessionId,
  signal,
}) {
  return {
    type: "warning",
    title: `Physical ${deviceName} access`,
    message: `Allow ${botLabel} to connect to CUA on this ${deviceName}?`,
    detail: `Task: ${taskLabel}. Bot ${botId}; session ${sessionId.slice(0, 8)}. Always Allow skips all future physical-computer connection prompts while this app stays open. Every action still passes the server's control and human-takeover gates.`,
    buttons: ["Deny", "Allow Once", "Always Allow While App Is Open"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
}

module.exports = { physicalApprovalDialogOptions };
