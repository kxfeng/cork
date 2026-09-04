import fs from "node:fs";
import path from "node:path";
import { paths } from "../config/paths.js";
import { newSessionId, sessionDir, type SessionMeta } from "../session/store.js";

/**
 * One-shot conversion of the pre-uuid session store.
 *
 * Old layout — the session key WAS the chat address:
 *   ~/.cork/sessions/lark_oc_abc.json
 *   ~/.cork/sessions/lark_oc_abc_omt_1.json
 *
 * New layout — an opaque id owning a directory, chat address inside the meta:
 *   ~/.cork/sessions/<uuid>/session.json
 *
 * Deliberately NOT run at daemon startup. It is a one-time job, and a one-time
 * job living on the startup path is a permanent cost plus a failure mode that
 * only ever appears on a restart. Upgrade cork, run `cork migrate-sessions`,
 * then `cork start`.
 *
 * Because a restart is part of that sequence, this does not try to keep running
 * panes alive: the daemon is down and its tmux sessions are going with it.
 *
 * Old files are moved to `sessions/.migrated/`, not deleted — if something about
 * a session looks wrong afterwards, the record it came from is still there. The
 * directory is skipped by listSessions, so it costs nothing to leave behind.
 */

export interface MigrationResult {
  migrated: Array<{ from: string; to: string; chat: string }>;
  skipped: string[];
  alreadyDone: number;
}

/** `<channel>_<chatId>[_<threadId>]` → its parts, or null if it isn't one. */
export function parseLegacyKey(key: string): {
  channel: string;
  chatId: string;
  threadId?: string;
} | null {
  const parts = key.split("_");
  if (parts.length < 2) return null;
  const channel = parts[0];
  const rest = parts.slice(1).join("_");
  // Lark thread ids are `omt_…`; a chat id never contains that marker, so this
  // splits `lark_oc_abc_omt_1` correctly without guessing at underscore counts.
  const marker = rest.indexOf("_omt_");
  if (marker >= 0) {
    return {
      channel,
      chatId: rest.slice(0, marker),
      threadId: rest.slice(marker + 1),
    };
  }
  return { channel, chatId: rest };
}

/**
 * Convert every `<key>.json` in the sessions dir. Metadata already carries
 * `channel`/`chatId`/`threadId` for anything cork wrote recently, so the key is
 * only parsed when the meta is missing them (older records).
 */
export function migrateSessions(dir: string = paths.sessionsDir): MigrationResult {
  const result: MigrationResult = { migrated: [], skipped: [], alreadyDone: 0 };

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return result; // nothing to migrate — a fresh install
  }

  const backupDir = path.join(dir, ".migrated");

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name !== ".migrated") result.alreadyDone++;
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;

    const legacyKey = entry.name.slice(0, -".json".length);
    const file = path.join(dir, entry.name);

    let meta: SessionMeta;
    try {
      meta = JSON.parse(fs.readFileSync(file, "utf-8")) as SessionMeta;
    } catch {
      result.skipped.push(`${entry.name} (unreadable)`);
      continue;
    }

    // Fill in whatever the record does not already state, from the key.
    const parsed = parseLegacyKey(legacyKey);
    if (!meta.chatId) {
      if (!parsed) {
        result.skipped.push(`${entry.name} (no chatId, unparseable name)`);
        continue;
      }
      meta.chatId = parsed.chatId;
    }
    if (!meta.channel) meta.channel = parsed?.channel ?? "lark";
    if (!meta.threadId && parsed?.threadId) meta.threadId = parsed.threadId;

    const id = newSessionId();
    fs.mkdirSync(sessionDir(id), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir(id), "session.json"),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );

    fs.mkdirSync(backupDir, { recursive: true });
    fs.renameSync(file, path.join(backupDir, entry.name));

    result.migrated.push({
      from: legacyKey,
      to: id,
      chat: `${meta.channel}:${meta.chatId}${meta.threadId ? `:${meta.threadId}` : ""}`,
    });
  }

  return result;
}

/** CLI entry: convert, then say what happened. */
export function migrateSessionsCommand(): void {
  const result = migrateSessions();

  if (result.migrated.length === 0 && result.skipped.length === 0) {
    console.log(
      result.alreadyDone > 0
        ? `Nothing to do — ${result.alreadyDone} session(s) already use the new layout.`
        : "Nothing to do — no session records found."
    );
    return;
  }

  for (const m of result.migrated) {
    console.log(`  ${m.from}  →  ${m.to}   (${m.chat})`);
  }
  for (const s of result.skipped) {
    console.log(`  skipped: ${s}`);
  }

  console.log(
    `\nMigrated ${result.migrated.length} session(s); ` +
      `${result.alreadyDone} already converted; ${result.skipped.length} skipped.`
  );
  console.log(
    `Old records kept in ${path.join(paths.sessionsDir, ".migrated")} — delete when you are satisfied.`
  );
  console.log("Now start the daemon: cork start");
}
