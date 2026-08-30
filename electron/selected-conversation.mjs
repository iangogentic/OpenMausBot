import fs from "node:fs";
import path from "node:path";

export function normalizeSelectedConversation(value) {
  const normalized = String(value ?? "").trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(normalized) ? normalized : "";
}

export function readSelectedConversation(file) {
  try {
    return normalizeSelectedConversation(fs.readFileSync(file, "utf8"));
  } catch {
    return "";
  }
}

export function writeSelectedConversation(file, value) {
  const raw = String(value ?? "");
  const id = normalizeSelectedConversation(raw);
  if (!id) {
    // Empty is an intentional clear (for example, after the final chat is
    // deleted). Invalid non-empty input remains rejected.
    if (raw.trim()) return false;
    try { fs.unlinkSync(file); } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${id}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, file);
    return true;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* rename already consumed it */ }
  }
}
