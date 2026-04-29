import type { Channel, IncomingMessage } from "../channels/types.js";
import type { SessionManager } from "../session/manager.js";
import { resolveWorkspacePath } from "../config/loader.js";
import { readLatestUsage, formatModelContext } from "../session/transcript.js";
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

  if (text === "/workspace") {
    return handleWorkspace(channel, message, sessionManager);
  }

  return { handled: false };
}

async function handleStatus(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.chatId);

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
    reply += `View: \`tmux attach -t cork_${session.key}\``;
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

  // Validate path
  if (pathArg && pathArg.includes("..")) {
    await channel.sendReply(message.chatId, "❌ Invalid path: '..' not allowed");
    return { handled: true };
  }

  const workspace = pathArg ? resolveWorkspacePath(pathArg) : undefined;

  if (workspace) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  const meta = sessionManager.createNewSession(message.chatId, workspace);

  let reply = `✅ New session created\n`;
  reply += `Workspace: \`${meta.workspace}\`\n`;
  reply += `Session: \`${meta.sessionId}\``;

  await channel.sendReply(message.chatId, reply);
  return { handled: true };
}

async function handleWorkspace(
  channel: Channel,
  message: IncomingMessage,
  sessionManager: SessionManager
): Promise<CommandResult> {
  const session = sessionManager.getSession(message.chatId);
  const workspace = session?.meta.workspace || "(no session)";
  await channel.sendReply(
    message.chatId,
    `📂 Current workspace: \`${workspace}\``
  );
  return { handled: true };
}
