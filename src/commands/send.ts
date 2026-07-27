import { enqueueCommand } from "../daemon/command-spool.js";

export interface SendOpts {
  channel: string;
  chat: string;
  text: string;
  at?: string[];
}

/**
 * Send a cork-initiated message to a chat via the daemon — the new-chat flow
 * uses this to post the greeting "@owner …" as the bot. `at` open ids are
 * rendered as real @mentions on Lark.
 *
 * Fire-and-forget: enqueues the command and returns. If the daemon is down the
 * command is discarded at its next startup (see command-spool.ts).
 */
export function sendCommand(opts: SendOpts): void {
  const id = enqueueCommand("send_message", {
    channel: opts.channel,
    chatId: opts.chat,
    text: opts.text,
    at: opts.at,
  });
  console.log(`queued send_message (${id}) to ${opts.channel}:${opts.chat}`);
}
