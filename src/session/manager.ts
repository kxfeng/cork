import { v4 as uuidv4 } from "uuid";
import fs from "node:fs";
import { ClaudeProcess, type ClaudeEvent } from "./process.js";
import {
  sessionKey,
  loadSession,
  saveSession,
  deleteSession,
  type SessionMeta,
} from "./store.js";
import { resolveWorkspacePath } from "../config/loader.js";
import type { CorkConfig } from "../config/schema.js";
import type { Channel, IncomingMessage } from "../channels/types.js";
import { getLogger } from "../logger.js";

const logger = getLogger("session-manager");

const DECISION_WINDOW_MS = 500;

interface ActiveSession {
  key: string;
  meta: SessionMeta;
  process: ClaudeProcess;
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private chatWorkspaces = new Map<string, string>();

  constructor(private config: CorkConfig) {}

  getCurrentWorkspace(chatId: string): string {
    return (
      this.chatWorkspaces.get(chatId) ||
      resolveWorkspacePath(this.config.defaultWorkspace)
    );
  }

  setCurrentWorkspace(chatId: string, workspace: string): void {
    this.chatWorkspaces.set(chatId, resolveWorkspacePath(workspace));
  }

  getSession(chatId: string, workspace?: string): ActiveSession | undefined {
    const ws = workspace || this.getCurrentWorkspace(chatId);
    const key = sessionKey(chatId, ws);
    return this.sessions.get(key);
  }

  /**
   * Ensure session is loaded into memory (from disk or newly created).
   * Does NOT spawn a claude process — just loads metadata.
   */
  ensureSession(message: IncomingMessage): ActiveSession {
    const workspace = this.getCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace);

    let session = this.sessions.get(key);
    if (session) return session;

    const existingMeta = loadSession(key);
    const sid = existingMeta?.sessionId || uuidv4();

    const meta: SessionMeta = existingMeta || {
      sessionId: sid,
      chatId: message.chatId,
      chatType: message.chatType,
      chatName: message.chatName || message.chatId,
      workspace,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
    };

    // Create a placeholder (process not yet spawned)
    const proc = new ClaudeProcess(sid);
    session = { key, meta, process: proc };
    this.sessions.set(key, session);
    return session;
  }

  async processMessage(
    channel: Channel,
    message: IncomingMessage
  ): Promise<void> {
    const workspace = this.getCurrentWorkspace(message.chatId);
    const key = sessionKey(message.chatId, workspace);

    // Ensure workspace directory exists
    fs.mkdirSync(workspace, { recursive: true });

    let session = this.sessions.get(key);
    const existingMeta = loadSession(key);
    // Only resume if session was previously used (has a message preview)
    const resume = !!existingMeta && existingMeta.lastMessagePreview !== "";
    const sid = existingMeta?.sessionId || uuidv4();

    // Spawn or re-spawn process if needed
    if (!session || !session.process.alive) {
      const proc = new ClaudeProcess(sid);

      const meta: SessionMeta = existingMeta || {
        sessionId: sid,
        chatId: message.chatId,
        chatType: message.chatType,
        chatName: message.chatName || message.chatId,
        workspace,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        lastMessagePreview: message.text.slice(0, 50),
      };

      session = { key, meta, process: proc };
      this.sessions.set(key, session);

      proc.spawn({
        workspace,
        sessionId: sid,
        resume,
        permissionMode: this.config.claude.permissionMode,
        extraArgs: this.config.claude.extraArgs,
      });

      // Handle process exit — mark session as needing respawn
      proc.on("exit", (code: number | null) => {
        logger.info("session process exited", { key, code });
      });
    }

    // Update meta
    session.meta.lastActiveAt = new Date().toISOString();
    session.meta.lastMessagePreview = message.text.slice(0, 50);
    if (message.chatName) {
      session.meta.chatName = message.chatName;
    }

    // Update session ID if process reported a different one
    if (session.process.sessionId !== session.meta.sessionId) {
      session.meta.sessionId = session.process.sessionId;
    }
    saveSession(key, session.meta);

    // Send message and stream response
    logger.info("sending message to claude process", { key, messageId: message.messageId, preview: message.text.slice(0, 50) });
    await this.sendAndCollectReply(channel, message, session);
    logger.info("claude response completed", { key, messageId: message.messageId });
  }

  private sendAndCollectReply(
    channel: Channel,
    message: IncomingMessage,
    session: ActiveSession
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const proc = session.process;
      let assistantText = "";
      let replyMessageId: string | null = null;
      let isStreaming = false;
      let decisionTimer: ReturnType<typeof setTimeout> | null = null;
      let completed = false;
      let lastUpdateTime = 0;

      const cleanup = () => {
        completed = true;
        if (decisionTimer) clearTimeout(decisionTimer);
        proc.removeListener("event", onEvent);
        proc.removeListener("exit", onExit);
        proc.removeListener("error", onError);
      };

      const startStreaming = async () => {
        if (isStreaming || completed) return;
        isStreaming = true;
        try {
          const result = await channel.sendReply(message.chatId, assistantText, {
            streaming: true,
          });
          replyMessageId = result.messageId;
          lastUpdateTime = Date.now();
        } catch (err) {
          logger.warn("failed to create streaming card", { err });
        }
      };

      const throttledUpdate = async () => {
        if (!replyMessageId || completed) return;
        const now = Date.now();
        if (now - lastUpdateTime >= DECISION_WINDOW_MS) {
          lastUpdateTime = now;
          try {
            await channel.sendReply(message.chatId, assistantText, {
              updateMessageId: replyMessageId,
              streaming: true,
            });
          } catch (err) {
            logger.warn("failed to update streaming card", { err });
          }
        }
      };

      const sendFinalReply = async () => {
        cleanup();
        try {
          if (!assistantText.trim()) {
            resolve();
            return;
          }
          logger.info(
            "sending final reply to lark",
            { messageId: message.messageId, replyLen: assistantText.length, streaming: isStreaming }
          );
          if (isStreaming && replyMessageId) {
            await channel.sendReply(message.chatId, assistantText, {
              updateMessageId: replyMessageId,
              streaming: true,
            });
          } else {
            await channel.sendReply(message.chatId, assistantText);
          }
          resolve();
        } catch (err) {
          reject(err as Error);
        }
      };

      const onEvent = (event: ClaudeEvent) => {
        if (completed) return;

        // Track session ID
        if (event.session_id && event.session_id !== session.meta.sessionId) {
          session.meta.sessionId = event.session_id;
          saveSession(session.key, session.meta);
        }

        // Accumulate assistant text
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantText = block.text;

              // Start decision window on first text
              if (!decisionTimer && !isStreaming) {
                decisionTimer = setTimeout(() => {
                  if (!completed) startStreaming();
                }, DECISION_WINDOW_MS);
              }

              if (isStreaming) {
                throttledUpdate();
              }
            }
          }
        }

        // Turn complete
        if (event.type === "result") {
          if (typeof event.result === "string") {
            assistantText = event.result;
          }
          sendFinalReply();
        }
      };

      const onExit = (code: number | null) => {
        if (completed) return;
        cleanup();
        if (code !== 0 && code !== null) {
          channel
            .sendReply(
              message.chatId,
              `⚠️ 会话进程异常退出 (exit code: ${code})，下次发消息会自动恢复会话。`
            )
            .then(() => resolve())
            .catch(reject);
        } else {
          // Normal exit with no result event — send whatever we have
          if (assistantText.trim()) {
            sendFinalReply();
          } else {
            resolve();
          }
        }
      };

      const onError = (err: Error) => {
        if (completed) return;
        cleanup();
        channel
          .sendReply(message.chatId, `❌ 会话进程错误: ${err.message}`)
          .then(() => resolve())
          .catch(reject);
      };

      proc.on("event", onEvent);
      proc.on("exit", onExit);
      proc.on("error", onError);

      // Send the user message
      try {
        proc.sendMessage(message.text);
      } catch (err) {
        cleanup();
        reject(err as Error);
      }
    });
  }

  createNewSession(chatId: string, workspace: string): SessionMeta {
    const ws = resolveWorkspacePath(workspace);
    const key = sessionKey(chatId, ws);

    // Kill existing process
    const existing = this.sessions.get(key);
    if (existing?.process.alive) {
      existing.process.kill();
    }
    this.sessions.delete(key);

    // Delete old session metadata
    deleteSession(key);

    const meta: SessionMeta = {
      sessionId: uuidv4(),
      chatId,
      chatType: "p2p",
      chatName: chatId,
      workspace: ws,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
    };

    saveSession(key, meta);
    this.setCurrentWorkspace(chatId, ws);
    return meta;
  }

  switchWorkspace(
    chatId: string,
    newWorkspace: string
  ): { meta: SessionMeta; resumed: boolean } {
    const ws = resolveWorkspacePath(newWorkspace);
    this.setCurrentWorkspace(chatId, ws);

    const key = sessionKey(chatId, ws);
    const existing = loadSession(key);
    if (existing) {
      return { meta: existing, resumed: true };
    }

    const meta = this.createNewSession(chatId, ws);
    return { meta, resumed: false };
  }

  async shutdown(): Promise<void> {
    for (const [, session] of this.sessions) {
      if (session.process.alive) {
        session.process.kill();
      }
    }
    this.sessions.clear();
  }
}
