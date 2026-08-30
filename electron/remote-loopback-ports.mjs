import fs from "node:fs";
import path from "node:path";

function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function normalizeRemoteLoopbackPorts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const server = value.server;
  const companion = value.companion ?? null;
  if (!validPort(server) || (companion !== null && !validPort(companion)) || server === companion) return null;
  return { version: 1, server, companion };
}

export function readRemoteLoopbackPorts(file) {
  try {
    return normalizeRemoteLoopbackPorts(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function writeRemoteLoopbackPorts(file, value) {
  const normalized = normalizeRemoteLoopbackPorts(value);
  if (!normalized) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(normalized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return true;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}
