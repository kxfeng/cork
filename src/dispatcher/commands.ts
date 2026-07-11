import type { Channel, IncomingMessage } from "../channels/types.js";
import type { SessionManager } from "../session/manager.js";
import { resolveWorkspacePath } from "../config/loader.js";
import { readLatestUsage, formatModelContext } from "../session/transcript.js";
import { TMUX_PREFIX, tmuxAttachHint } from "../session/tmux.js";
import fs from "node:fs";

export interface CommandResult {
  handled: boolean;
}

/**
 * Send a command reply, threading it back into the originating Lark thread when
 * the triggering message was in one — so `/status` etc. answer inside the thread
 * rather than the main chat.
 */
function sendCmdReply(
  channel: Channel,
  message: IncomingMessage,
  content: string
): Promise<unknown> {
  return channel.sendReply(
    message.chatId,
    content,
    message.threadId
      ? { replyToMessageId: message.messageId, replyInThread: true }
      : undefined
  );
}

export async function handleCommand(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const text = message.text.trim();

  if (text === "/status") {
    return handleStatus(channel, message, sessionManager);
  }

  if (text === "/new" || text.startsWith("/new ")) {
    return handleNew(channel, message, sessionManager, text);
  }

  if (text === "/workspace") {
    return handleWorkspace(channel, message, sessionManager);
  }

  if (text === "/mention-off") {
    return handleMentionOff(channel, message, sessionManager);
  }

  if (text === "/mention-on") {
    return handleMentionOn(channel, message, sessionManager);
  }

  return { handled: false };
}

async function handleStatus(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.channel, message.chatId, message.threadId);

  let reply = `📊 **Session Status**\n`;

  if (session) {
    // Chat info
    if (session.meta.chatType === "group") {
      reply += `Mention: \`${session.meta.mentionRequired ? "on" : "off"}\`\n`;
    }

    reply += `Workspace: \`${session.meta.workspace}\`\n`;
    reply += `Cork session: \`${session.key}\`\n`;
    reply += `Claude session: \`${session.meta.sessionId}\`\n`;
    const usage = await readLatestUsage(session.meta.workspace, session.meta.sessionId);
    reply += `Claude context: \`${formatModelContext(usage)}\`\n`;
    reply += `View: \`${tmuxAttachHint(`${TMUX_PREFIX}${session.key}`)}\``;
  } else {
    reply += `No session yet (send a message to start one)`;
  }

  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleNew(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  const pathArg = text.slice("/new".length).trim();

  // Validate path
  if (pathArg && pathArg.includes("..")) {
    await sendCmdReply(channel, message, "❌ Invalid path: '..' not allowed");
    return { handled: true };
  }

  const workspace = pathArg ? resolveWorkspacePath(pathArg) : undefined;

  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  const meta = sessionManager.createNewSession(
    message.channel,
    message.chatId,
    message.threadId,
    workspace
  );

  let reply = `✅ New session created\n`;
  reply += `Workspace: \`${meta.workspace}\`\n`;
  reply += `Session: \`${meta.sessionId}\``;

  await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleWorkspace(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.channel, message.chatId, message.threadId);
  const workspace = session?.meta.workspace || "(no session)";
  await sendCmdReply(channel, message, `📂 Current workspace: \`${workspace}\``);
  return { handled: true };
}

async function handleMentionOff(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  if (message.chatType !== "group") {
    await sendCmdReply(channel, message, "ℹ️ /mention-off only applies to group chats.");
    return { handled: true };
  }
  sessionManager.setMentionRequired(message.channel, message.chatId, false);
  await sendCmdReply(channel, message, "✅ Mention requirement disabled. Owner messages will be processed without @bot.");
  return { handled: true };
}

async function handleMentionOn(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  if (message.chatType !== "group") {
    await sendCmdReply(channel, message, "ℹ️ /mention-on only applies to group chats.");
    return { handled: true };
  }
  sessionManager.setMentionRequired(message.channel, message.chatId, true);
  await sendCmdReply(channel, message, "✅ Mention requirement enabled. @bot is required again.");
  return { handled: true };
}
