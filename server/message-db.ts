// SQLite persistence for thread transcripts.
//
// messages-<threadId>.json rewrote the WHOLE thread file on every append —
// a long computer-use thread reaches megabytes, so each new message cost
// more disk than the last. This store writes deltas instead: one INSERT
// per message, one UPDATE per patch, and reads a thread once into the
// Store's in-memory cache. node:sqlite (built into Node ≥23.4) keeps it
// dependency-free — nothing new to bundle for the packaged app.
//
// Legacy JSON thread files import lazily: the first read of a thread with
// no rows pulls the old file in, after which the DB is the source of
// truth (the JSON file is left behind as a one-time backup).
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DATA_DIR } from "./config.ts";
import type { Message } from "./store.ts";

const DB_FILE = () => join(DATA_DIR, "messages.db");

let handle: DatabaseSync | null = null;
let handlePath: string | null = null;

function open(): DatabaseSync {
  const file = DB_FILE();
  // Transcripts can contain private conversations and tool output. Create
  // the database with owner-only permissions and also repair an existing
  // file that may have inherited a permissive umask.
  closeSync(openSync(file, "a", 0o600));
  try {
    chmodSync(file, 0o600);
  } catch {}
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      at INTEGER NOT NULL,
      role TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT,
      json TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
    CREATE TABLE IF NOT EXISTS thread_state (
      thread_id TEXT PRIMARY KEY,
      active_leaf_id TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS message_search_v2 USING fts5(
      thread_id UNINDEXED,
      message_id UNINDEXED,
      body,
      tokenize='trigram'
    );
  `);
  // The index is derived state. Rebuild when upgrading an existing database
  // or recovering from a crash between the transcript write and index write.
  const messageCount = (db.prepare("SELECT count(*) AS count FROM messages").get() as { count: number }).count;
  const searchCount = (db.prepare("SELECT count(*) AS count FROM message_search_v2").get() as { count: number }).count;
  if (messageCount !== searchCount) rebuildSearchIndex(db);
  // v1 indexed raw attachment tags, including private parent directories.
  // Once the redacted index is durable, remove that derived legacy table.
  db.exec("DROP TABLE IF EXISTS message_search");
  return db;
}

function searchableRowText(text: string | null, json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    parsed = null;
  }
  const message = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  const tool = message?.tool && typeof message.tool === "object" ? message.tool as Record<string, unknown> : null;
  const from = message?.from && typeof message.from === "object" ? message.from as Record<string, unknown> : null;
  return [visibleSearchText(text), typeof tool?.name === "string" ? tool.name : null, typeof from?.name === "string" ? from.name : null]
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

/** Transcript attachment tags contain real Mac/Razer paths for the model.
 * Search may index the useful basename, never the private parent directories. */
function visibleSearchText(text: string | null): string | null {
  if (!text) return text;
  return text.replace(
    /<attached-(?:image|file)\s+path="([^"]*)"\s*\/?>(?:\s*\n)?/g,
    (_tag, encodedPath: string) => {
      const encodedName = encodedPath.split(/[\\/]/).at(-1) ?? "";
      const name = encodedName
        .replaceAll("&#9;", " ")
        .replaceAll("&#10;", " ")
        .replaceAll("&#13;", " ")
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
        .replace(/[\0-\x1f\x7f]/g, "")
        .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, "")
        .slice(0, 180);
      return name ? `[attachment: ${name}]` : "[attachment]";
    },
  );
}

function rebuildSearchIndex(database: DatabaseSync): void {
  const rows = database.prepare("SELECT thread_id, id, text, json FROM messages").all() as Array<{
    thread_id: string;
    id: string;
    text: string | null;
    json: string;
  }>;
  const insert = database.prepare("INSERT INTO message_search_v2 (thread_id, message_id, body) VALUES (?, ?, ?)");
  database.exec("BEGIN");
  try {
    database.exec("DELETE FROM message_search_v2");
    for (const row of rows) insert.run(row.thread_id, row.id, searchableRowText(row.text, row.json));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function indexMessage(database: DatabaseSync, threadId: string, message: Message): void {
  database.prepare("DELETE FROM message_search_v2 WHERE thread_id = ? AND message_id = ?").run(threadId, message.id);
  database.prepare("INSERT INTO message_search_v2 (thread_id, message_id, body) VALUES (?, ?, ?)")
    .run(threadId, message.id, searchableRowText(message.text ?? null, JSON.stringify(message)));
}

/** The live handle — reopened when the file was removed out from under us
 * (tests wipe DATA_DIR between cases; a fresh Store must get a fresh DB,
 * not a handle onto an unlinked inode). */
function db(): DatabaseSync {
  if (handle && handlePath === DB_FILE() && existsSync(DB_FILE())) return handle;
  try {
    handle?.close();
  } catch {}
  handle = open();
  handlePath = DB_FILE();
  return handle;
}

const rowToMessage = (row: { json: string }): Message => JSON.parse(row.json) as Message;

export interface ThreadRows {
  messages: Message[];
  activeLeafId: string | null;
}

/** Read one thread, importing its legacy JSON file on first touch. */
export function readThread(threadId: string, legacyFile: string): ThreadRows {
  const rows = db()
    .prepare("SELECT json FROM messages WHERE thread_id = ? ORDER BY rowid")
    .all(threadId) as Array<{ json: string }>;
  if (rows.length) {
    const state = db()
      .prepare("SELECT active_leaf_id FROM thread_state WHERE thread_id = ?")
      .get(threadId) as { active_leaf_id: string | null } | undefined;
    return { messages: rows.map(rowToMessage), activeLeafId: state?.active_leaf_id ?? null };
  }
  return importLegacy(threadId, legacyFile);
}

function importLegacy(threadId: string, legacyFile: string): ThreadRows {
  let messages: Message[] = [];
  let activeLeafId: string | null = null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch {
    return { messages, activeLeafId }; // fresh thread
  }
  if (Array.isArray(raw)) messages = raw as Message[]; // pre-branching flat file
  else if (raw && typeof raw === "object") {
    messages = ((raw as { messages?: Message[] }).messages ?? []) as Message[];
    activeLeafId = (raw as { activeLeafId?: string | null }).activeLeafId ?? null;
  }
  const insert = db().prepare(
    "INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const index = db().prepare("INSERT INTO message_search_v2 (thread_id, message_id, body) VALUES (?, ?, ?)");
  db().exec("BEGIN");
  try {
    for (const message of messages) {
      const json = JSON.stringify(message);
      insert.run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, json);
      index.run(threadId, message.id, searchableRowText(message.text ?? null, json));
    }
    setActiveLeaf(threadId, activeLeafId);
    db().exec("COMMIT");
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
  // left beside the DB as a one-time backup, renamed so the import never
  // runs twice against a thread whose rows were later deleted
  try {
    renameSync(legacyFile, `${legacyFile}.imported`);
    try {
      chmodSync(`${legacyFile}.imported`, 0o600);
    } catch {}
  } catch {}
  return { messages, activeLeafId };
}

export function insertMessage(threadId: string, message: Message): void {
  const database = db();
  database
    .prepare("INSERT OR REPLACE INTO messages (thread_id, id, at, role, kind, text, json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(threadId, message.id, message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message));
  indexMessage(database, threadId, message);
}

/** Persist a new message and the branch head as one crash-safe mutation. */
export function appendMessage(threadId: string, message: Message): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    insertMessage(threadId, message);
    setActiveLeaf(threadId, message.id);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function updateMessage(threadId: string, message: Message): void {
  const database = db();
  database
    .prepare("UPDATE messages SET at = ?, role = ?, kind = ?, text = ?, json = ? WHERE thread_id = ? AND id = ?")
    .run(message.at, message.role, message.kind, message.text ?? null, JSON.stringify(message), threadId, message.id);
  indexMessage(database, threadId, message);
}

export function setActiveLeaf(threadId: string, leafId: string | null): void {
  db()
    .prepare(
      "INSERT INTO thread_state (thread_id, active_leaf_id) VALUES (?, ?) " +
        "ON CONFLICT(thread_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id",
    )
    .run(threadId, leafId);
}

export function deleteThread(threadId: string): void {
  const database = db();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM messages WHERE thread_id = ?").run(threadId);
    database.prepare("DELETE FROM message_search_v2 WHERE thread_id = ?").run(threadId);
    database.prepare("DELETE FROM thread_state WHERE thread_id = ?").run(threadId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export interface SearchHit {
  threadId: string;
  messageId: string;
  at: number;
  role: string;
  kind: string;
  /** the matched text, trimmed to a window around the first hit */
  snippet: string;
  /** where the match sits inside `snippet`, for highlighting */
  matchStart: number;
  matchLength: number;
  /** room messages: which member said it */
  from?: string;
}

/** Case-insensitive indexed substring search over visible transcript text,
 * newest first. One- and two-character queries use a bounded LIKE fallback
 * because FTS5's trigram tokenizer intentionally has no shorter tokens. */
export function searchMessages(query: string, limit = 40, threadId?: string): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  // escape LIKE wildcards so a literal % or _ in the query stays literal
  const pattern = `%${needle.replace(/([\\%_])/g, "\\$1")}%`;
  // text messages by their text; activity chips by the tool name — "which
  // bot ran that migration" is a tool-name question. The chip's name lives
  // in the row's json; a JSON1 extract keeps this one query.
  const database = db();
  const shortQuery = [...needle].length < 3;
  const scope = threadId ? "m.thread_id = ? AND " : "";
  const statement = shortQuery
    ? database.prepare(
      "SELECT m.thread_id, m.id, m.at, m.role, m.kind, m.text, json_extract(m.json, '$.tool.name') AS tool_name, json_extract(m.json, '$.from.name') AS from_name " +
        "FROM messages m " +
        `WHERE ${scope}lower(coalesce(m.text, '') || char(10) || coalesce(tool_name, '') || char(10) || coalesce(from_name, '')) LIKE ? ESCAPE '\\' ` +
        "ORDER BY m.at DESC LIMIT ?",
    )
    : database.prepare(
      "SELECT m.thread_id, m.id, m.at, m.role, m.kind, m.text, json_extract(m.json, '$.tool.name') AS tool_name, json_extract(m.json, '$.from.name') AS from_name " +
        "FROM message_search_v2 s JOIN messages m ON m.thread_id = s.thread_id AND m.id = s.message_id " +
        `WHERE ${scope}s.body MATCH ? ORDER BY m.at DESC LIMIT ?`,
    );
  const ftsQuery = `"${needle.replace(/"/g, '""')}"`;
  const rows = (threadId
    ? statement.all(threadId, shortQuery ? pattern : ftsQuery, limit)
    : statement.all(shortQuery ? pattern : ftsQuery, limit)) as Array<{
    thread_id: string;
    id: string;
    at: number;
    role: string;
    kind: string;
    text: string | null;
    tool_name: string | null;
    from_name: string | null;
  }>;
  return rows.map((row) => {
    const haystack = [visibleSearchText(row.text), row.tool_name, row.from_name].filter(Boolean).join("\n");
    const hitAt = Math.max(0, haystack.toLowerCase().indexOf(needle));
    const start = Math.max(0, hitAt - 60);
    const end = Math.min(haystack.length, hitAt + needle.length + 90);
    const head = start > 0 ? "…" : "";
    const body = haystack.slice(start, end).replace(/\s+/g, " ").trim();
    const snippet = head + body + (end < haystack.length ? "…" : "");
    // whitespace folding can shift the offset; find the match again inside
    const folded = needle.replace(/\s+/g, " ");
    const matchStart = snippet.toLowerCase().indexOf(folded);
    return {
      threadId: row.thread_id,
      messageId: row.id,
      at: row.at,
      role: row.role,
      kind: row.kind,
      snippet,
      matchStart: matchStart < 0 ? head.length : matchStart,
      // A defensive fallback must not mark arbitrary snippet text as the hit.
      matchLength: matchStart < 0 ? 0 : folded.length,
      ...(row.from_name ? { from: row.from_name } : {}),
    };
  });
}

/** Test/shutdown hook — closes the handle so a wiped DATA_DIR starts clean. */
export function closeMessageDb(): void {
  try {
    handle?.close();
  } catch {}
  handle = null;
  handlePath = null;
}
