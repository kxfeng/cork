import type { Channel, IncomingMessage } from "../channels/types.js";
import type { SessionManager } from "../session/manager.js";
import { resolveWorkspacePath } from "../config/loader.js";
import { paths } from "../config/paths.js";
import { getChatSettings } from "../channels/lark/chat-settings.js";
import fs from "node:fs";

export interface CommandResult {
  handled: boolean;
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

  if (text === "/workspace" || text.startsWith("/workspace ")) {
    return handleWorkspace(channel, message, sessionManager, text);
  }

  return { handled: false };
}

async function handleStatus(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const workspace = sessionManager.getCurrentWorkspace(message.chatId);
  const session = sessionManager.getSession(message.chatId);

  let reply = `📊 **Session Status**\n`;

  // Chat info
  if (message.chatType === "group") {
    const settings = getChatSettings(message.chatId);
    reply += `Chat: group\n`;
    reply += `Mention: ${settings.mentionRequired ? "on" : "off"}\n`;
  }

  // Cork session
  reply += `Workspace: \`${workspace}\`\n`;
  if (session) {
    reply += `Cork session: \`${session.key}\`\n`;
    reply += `Status: ${session.process.alive ? "active" : "idle"}\n`;
    reply += `Last active: ${session.meta.lastActiveAt}\n`;
    reply += `Claude session: \`cd ${workspace} && claude -r ${session.meta.sessionId}\``;
  } else {
    reply += `No session yet (send a message to start one)`;
  }

  await channel.sendReply(message.chatId, reply);
  return { handled: true };
}

async function handleNew(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  const pathArg = text.slice("/new".length).trim();
  const workspace = pathArg
    ? resolveWorkspacePath(pathArg)
    : sessionManager.getCurrentWorkspace(message.chatId);

  // Validate path
  if (pathArg && pathArg.includes("..")) {
    await channel.sendReply(message.chatId, "❌ Invalid path: '..' not allowed");
    return { handled: true };
  }

  // Create directory if needed
  fs.mkdirSync(workspace, { recursive: true });

  const meta = sessionManager.createNewSession(message.chatId, workspace);

  let reply = `✅ New session created\n`;
  reply += `Workspace: \`${workspace}\`\n`;
  reply += `Session: \`${meta.sessionId}\``;

  await channel.sendReply(message.chatId, reply);
  return { handled: true };
}

async function handleWorkspace(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager,
  text: string
): Promise<CommandResult> {
  const pathArg = text.slice("/workspace".length).trim();

  if (!pathArg) {
    const workspace = sessionManager.getCurrentWorkspace(message.chatId);
    await channel.sendReply(
      message.chatId,
      `📂 Current workspace: \`${workspace}\``
    );
    return { handled: true };
  }

  // Validate path
  if (pathArg.includes("..")) {
    await channel.sendReply(message.chatId, "❌ Invalid path: '..' not allowed");
    return { handled: true };
  }

  const resolved = resolveWorkspacePath(pathArg);
  fs.mkdirSync(resolved, { recursive: true });

  const { meta, resumed } = sessionManager.switchWorkspace(
    message.chatId,
    pathArg
  );

  let reply = `✅ Workspace switched\n`;
  reply += `To: \`${resolved}\``;
  if (resumed) {
    reply += ` (resumed)`;
  }
  reply += `\nSession: \`${meta.sessionId}\``;

  await channel.sendReply(message.chatId, reply);
  return { handled: true };
}
