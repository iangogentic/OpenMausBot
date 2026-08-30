// Native (un-normalized) protocol tee — the debugging trick from upstream's
// EventNdjsonLogger and agentcal's onRaw: every provider-native message is
// written verbatim next to the canonical stream, so protocol drift can be
// diagnosed by diffing the two.
import { NATIVE_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { appendBoundedNdjson } from "../bounded-log.ts";

export function appendNative(threadId: string, entry: { dir: "in" | "out"; source: string; msg: unknown }) {
  try {
    // The session-setup messages carry the credentials the agent is handed —
    // the box and comms tokens ride inside session/new's mcpServers env, and
    // an MCP header can carry a Composio key. These files are ordinary
    // 0644 files people paste into bug reports, so values are masked while
    // the shape stays intact.
    appendBoundedNdjson(NATIVE_DIR, threadId, {
      at: new Date().toISOString(),
      ...entry,
      msg: redactSecrets(entry.msg),
    });
  } catch {
    /* never let logging break a run */
  }
}
