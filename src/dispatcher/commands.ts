import type { Channel, IncomingMessage } from "../channels/types.js";
import type { SessionManager } from "../session/manager.js";
import { resolveWorkspacePath } from "../config/loader.js";
import { sessionKey } from "../session/store.js";
import { collectStatus, formatStatusMarkdown } from "../session/status.js";
import { findScriptCommand, runScriptCommand } from "./script-commands.js";
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

  // Built-ins are matched above, so a user script can never shadow one.
  return handleScript(channel, message, sessionManager, text);
}

/**
 * Answer `/name …` from ~/.cork/commands/name when such an executable exists.
 * Anything else falls through to claude, unchanged.
 */
async function handleScript(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  if (!text.startsWith("/")) return { handled: false };

  const space = text.search(/\s/);
  const name = (space === -1 ? text : text.slice(0, space)).slice(1);
  const args = space === -1 ? "" : text.slice(space + 1).trim();

  const file = findScriptCommand(name);
  if (!file) return { handled: false };

  const session = sessionManager.getSession(
    message.channel,
    message.chatId,
    message.threadId
  );
  const key =
    session?.key ??
    sessionKey(message.channel, message.chatId, message.threadId);
  const workspace = session?.meta.workspace ?? sessionManager.defaultWorkspace();

  const { reply } = await runScriptCommand(
    name,
    file,
    args,
    message,
    key,
    workspace
  );

  if (reply) await sendCmdReply(channel, message, reply);
  return { handled: true };
}

async function handleStatus(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.channel, message.chatId, message.threadId);

  let reply = `📊 **Session Status**\n`;

  if (session) {
    reply += formatStatusMarkdown(await collectStatus(session.key, session.meta));
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
