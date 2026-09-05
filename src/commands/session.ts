import { enqueueCommand } from "../daemon/command-spool.js";
import { listSessions } from "../session/store.js";
import type { SessionMeta } from "../session/store.js";
import { TMUX_PREFIX, tmuxAttachHint } from "../session/tmux.js";
import { readLatestUsage, formatModelContext } from "../session/transcript.js";

/**
 * What to call a chat. A session warmed before anyone spoke, or one on a
 * channel that cannot look titles up, is stored under its own chat id — show
 * that rather than an empty column.
 */
function displayName(meta: SessionMeta): string {
  return meta.chatName && meta.chatName !== meta.chatId
    ? meta.chatName
    : meta.chatId;
}

/**
 * Order sessions for `cork session list`: by name, not by recency as the web
 * view does. The two differ because a terminal scrolls — 8 lines per session
 * means a long list leaves you at the bottom, so putting the most recent first
 * hides it. A name order also holds still between runs, which is what a
 * command you run several times a day wants.
 *
 * Key breaks the tie, which is load-bearing rather than cosmetic: a thread
 * session carries its parent chat's name, so without it a thread can sort
 * above the chat it belongs to. Keys share the parent's prefix, so the parent
 * always comes first.
 */
export function sortSessionsForDisplay<
  T extends { key: string; meta: SessionMeta },
>(sessions: T[]): T[] {
  return [...sessions].sort(
    (a, b) =>
      displayName(a.meta).localeCompare(displayName(b.meta)) ||
      a.key.localeCompare(b.key)
  );
}

/**
 * The full session inventory. It lives here rather than in `cork status`
 * because it grows without bound: one busy day of chats pushes the daemon
 * header — the part you ran `status` for — off the top of the screen. `status`
 * keeps the count and points here.
 */
export async function sessionList(): Promise<void> {
  const sessions = sortSessionsForDisplay(listSessions());
  console.log(`=== Sessions (${sessions.length}) ===`);
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }

  for (const { key, meta } of sessions) {
    const typeLabel = meta.chatType === "group" ? "Group" : "P2P";
    // Without this a thread is indistinguishable from its parent chat: both
    // carry the same name and type, and only the key suffix tells them apart.
    const label = meta.threadId ? `${typeLabel}, thread` : typeLabel;
    const name = displayName(meta);
    const usage = await readLatestUsage(meta.workspace, meta.sessionId);
    // Labels padded to a common 15-char column so the colons line up.
    console.log(`[${key}]`);
    console.log(`  Chat:           ${name} (${label})`);
    console.log(`  Workspace:      ${meta.workspace}`);
    console.log(`  Claude session: ${meta.sessionId}`);
    console.log(`  Claude context: ${formatModelContext(usage)}`);
    console.log(`  Last active:    ${meta.lastActiveAt}`);
    console.log(`  Last msg:       ${meta.lastMessagePreview || "(none)"}`);
    console.log(`  Terminal:       ${tmuxAttachHint(`${TMUX_PREFIX}${key}`)}`);
    console.log();
  }
}

export interface SessionCreateOpts {
  channel: string;
  chat: string;
  workspace?: string;
}

/**
 * Ask the daemon to create and warm a session for a chat, so the pane is already
 * connected by the time the first user message arrives (see
 * SessionManager.prepareSession). The new-chat flow runs this right after
 * creating the group and greeting the owner. `mentionRequired` is fixed to false
 * — a task group should answer without an @mention.
 *
 * Fire-and-forget: enqueues the command and returns. If the daemon is down the
 * command is discarded at its next startup (commands are immediate intent, not
 * durable work — see command-spool.ts).
 */
export function sessionCreate(opts: SessionCreateOpts): void {
  const id = enqueueCommand("create_session", {
    channel: opts.channel,
    chatId: opts.chat,
    workspace: opts.workspace,
    mentionRequired: false,
  });
  console.log(`queued create_session (${id}) for ${opts.channel}:${opts.chat}`);
}
