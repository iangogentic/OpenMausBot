const fs = require("node:fs");
const { createHash } = require("node:crypto");

/**
 * Stable identity of the far-end standalone CUA daemon's Unix socket.
 *
 * A fresh MCP stdio child is not restart proof: both children can forward to
 * one daemon while an old click is still running. The socket file's kernel
 * identity changes only when that daemon endpoint is actually recreated, so
 * it is safe to use as the executor epoch. Missing/unverifiable identity stays
 * null and therefore remains conservatively fenced.
 */
function standaloneExecutorGeneration(socketPath, fileSystem = fs) {
  try {
    const stat = fileSystem.statSync(socketPath, { bigint: true });
    if (!stat.isSocket()) return null;
    const birth = stat.birthtimeNs ?? BigInt(Math.trunc(Number(stat.birthtimeMs) * 1_000_000));
    return createHash("sha256")
      .update(`cua-standalone-v1\0${stat.dev}\0${stat.ino}\0${birth}`)
      .digest("hex");
  } catch {
    return null;
  }
}

module.exports = { standaloneExecutorGeneration };
