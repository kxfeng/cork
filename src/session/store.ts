import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { paths } from "../config/paths.js";

/**
 * The channel name for a session that belongs to no chat at all — created from
 * the web view, driven only by typing in the pane. It is spelled as a channel
 * because meta carries one for every session, and doing so means every lookup
 * and tmux name keeps working untouched. There is no adapter by this name,
 * which is the point: nothing routes to it.
 */
export const LOCAL_CHANNEL = "local";

export interface SessionMeta {
  sessionId: string;
  /** Channel this session belongs to (e.g. "lark", "telegram"). Lets the daemon
   * route replies back through the originating channel. Optional for backward
   * compat with pre-multichannel session files (absent ⇒ treat as "lark"). */
  channel?: string;
  chatId: string;
  /** Lark thread id (omt_…) when this session is a thread; absent for a
   * whole-chat session. Part of what identifies a session, alongside
   * channel + chatId. */
  threadId?: string;
  chatType: "p2p" | "group";
  chatName: string;
  workspace: string;
  createdAt: string;
  lastActiveAt: string;
  lastMessagePreview: string;
  // Whether Claude Code session was ever successfully started with this sessionId
  claudeSessionStarted: boolean;
  // Chat settings (previously in separate chat_setting_ files)
  mentionRequired: boolean;
}

/**
 * A session id is an opaque uuid, and each session owns a DIRECTORY named by it:
 *
 *   ~/.cork/sessions/<id>/session.json   ← the SessionMeta below
 *   ~/.cork/sessions/<id>/GOAL.md        ← autopilot files, written later
 *   ~/.cork/sessions/<id>/PROJECT.md
 *   ~/.cork/sessions/<id>/AUTOPILOT.json
 *
 * The id deliberately says nothing about which chat it serves: `channel`,
 * `chatId` and `threadId` live in the meta, so a session can be re-pointed at a
 * different channel later without renaming its directory, its tmux session or
 * its files. (It used to be `<channel>_<chatId>[_<threadId>]`, which baked the
 * channel into every one of those names — see migrate-sessions for the
 * one-shot conversion.)
 *
 * Everything outside this module treats the id as opaque and calls it `key`.
 */
const META_FILE = "session.json";

/** Ids we will touch on disk. Anything else is a path traversal attempt or a
 *  stray file, and must not resolve to a directory we would read or delete. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function validId(id: string): boolean {
  return ID_RE.test(id) && id.length <= 128;
}

/** Mint an id for a brand-new session. */
export function newSessionId(): string {
  return uuidv4();
}

/** A session's own directory — where autopilot files live alongside the meta. */
export function sessionDir(id: string): string {
  return path.join(paths.sessionsDir, id);
}

function metaPath(id: string): string {
  return path.join(sessionDir(id), META_FILE);
}

export function loadSession(id: string): SessionMeta | null {
  if (!validId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf-8")) as SessionMeta;
  } catch {
    // Missing, unreadable, or half-written — all mean "no usable record".
    return null;
  }
}

export function saveSession(id: string, meta: SessionMeta): void {
  if (!validId(id)) throw new Error(`invalid session id: ${id}`);
  fs.mkdirSync(sessionDir(id), { recursive: true });
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Forget a session: the whole directory goes, autopilot files included. Claude's
 * own transcript is untouched — that lives under ~/.claude and is not ours.
 */
export function deleteSession(id: string): void {
  if (!validId(id)) return;
  fs.rmSync(sessionDir(id), { recursive: true, force: true });
}

export function listSessions(): Array<{ key: string; meta: SessionMeta }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: Array<{ key: string; meta: SessionMeta }> = [];
  for (const entry of entries) {
    // Only id-shaped directories. Skips the migration backup (`.migrated`),
    // any leftover pre-migration `<key>.json`, and editor droppings.
    if (!entry.isDirectory() || !validId(entry.name)) continue;
    const meta = loadSession(entry.name);
    if (meta) results.push({ key: entry.name, meta });
  }
  return results;
}

/** Does this record serve exactly this (channel, chat, thread)? */
function serves(
  meta: SessionMeta,
  channel: string,
  chatId: string,
  threadId?: string
): boolean {
  return (
    (meta.channel ?? "lark") === channel &&
    meta.chatId === chatId &&
    (meta.threadId ?? undefined) === (threadId ?? undefined)
  );
}

/**
 * The id of the session serving a chat (or one of its threads), or null.
 *
 * Scans the store, so callers that ask per message keep an index instead —
 * SessionManager builds one at startup and maintains it as sessions are
 * created. This is the authority the index is built from, not a hot path.
 */
export function findSessionId(
  channel: string,
  chatId: string,
  threadId?: string
): string | null {
  for (const { key, meta } of listSessions()) {
    if (serves(meta, channel, chatId, threadId)) return key;
  }
  return null;
}

/** Every session belonging to a chat: the chat's own, plus its threads. */
export function findChatSessionIds(channel: string, chatId: string): string[] {
  const ids: string[] = [];
  for (const { key, meta } of listSessions()) {
    if ((meta.channel ?? "lark") === channel && meta.chatId === chatId) {
      ids.push(key);
    }
  }
  return ids;
}
