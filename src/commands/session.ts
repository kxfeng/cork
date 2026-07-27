import { enqueueCommand } from "../daemon/command-spool.js";

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
