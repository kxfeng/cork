import { v4 as uuidv4 } from "uuid";
import { execSync } from "node:child_process";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import {
  sessionKey,
  loadSession,
  saveSession,
  deleteSession,
  type SessionMeta,
} from "./store.js";
import { resolveWorkspacePath } from "../config/loader.js";
import type { CorkConfig } from "../config/schema.js";
import type { IncomingMessage } from "../channels/types.js";
import type { UdsServer, UdsMessage } from "../daemon/uds-server.js";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("session-manager");

const STARTING_TIMEOUT_MS = 30_000;
const TMUX_PREFIX = "cork_";

type SessionState = "inactive" | "starting" | "connected";

interface QueuedMessage {
  chatId: string;
  content: string;
  meta: Record<string, string>;
}

interface PendingReaction {
  messageId: string;
  reactionId: string;
}

interface ActiveSession {
  key: string;
  meta: SessionMeta;
  state: SessionState;
  messageQueue: QueuedMessage[];
  startingTimer?: ReturnType<typeof setTimeout>;
  channelEnterSentAt?: number;
  pendingRegistration?: boolean;
  pendingReactions: PendingReaction[];
}

const CHANNEL_READY_DELAY_MS = 1500;

/**
 * Manages Claude Code sessions via tmux + UDS.
 *
 * State machine per session:
 *   inactive → starting → connected
 *      ↑         |            |
 *      |      timeout/        |
 *      |      failure         |
 *      |_________|     disconnect
 *      |_____________________|
 *
 * Events:
 * - "reply" (sessionKey, content) — reply from Claude, forward to Lark
 * - "permission_request" (sessionKey, msg) — permission prompt from Claude
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ActiveSession>();
  private udsServer: UdsServer | null = null;
  private channelServerPath: string;

  constructor(private config: CorkConfig) {
    super();
    this.channelServerPath = this.resolveChannelServerPath();
  }

  setUdsServer(uds: UdsServer): void {
    this.udsServer = uds;

    uds.on("register", (key: string) => {
      this.onChannelRegistered(key);
    });

    uds.on("disconnect", (key: string) => {
      this.onChannelDisconnected(key);
    });
  }

  getSession(chatId: string): ActiveSession | undefined {
    const key = sessionKey("lark", chatId);
    return this.sessions.get(key);
  }

  getSessionByKey(key: string): ActiveSession | undefined {
    return this.sessions.get(key);
  }

  /**
   * Ensure session metadata is loaded into memory (from disk or newly created).
   * Does NOT start tmux — just loads metadata.
   */
  ensureSession(message: IncomingMessage): ActiveSession {
    const key = sessionKey("lark", message.chatId);

    let session = this.sessions.get(key);
    if (session) return session;

    const existingMeta = loadSession(key);
    const sid = existingMeta?.sessionId || uuidv4();
    const workspace =
      existingMeta?.workspace ||
      resolveWorkspacePath(this.config.defaultWorkspace);

    const meta: SessionMeta = existingMeta || {
      sessionId: sid,
      chatId: message.chatId,
      chatType: message.chatType,
      chatName: message.chatName || message.chatId,
      workspace,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      lastMessagePreview: "",
      claudeSessionStarted: false,
      mentionRequired: true,
    };

    session = { key, meta, state: "inactive", messageQueue: [], pendingReactions: [] };
    this.sessions.set(key, session);
    return session;
  }

  trackPendingReaction(key: string, messageId: string, reactionId: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    session.pendingReactions.push({ messageId, reactionId });
  }

  popPendingReaction(key: string): PendingReaction | undefined {
    const session = this.sessions.get(key);
    if (!session) return undefined;
    return session.pendingReactions.shift();
  }

  /**
   * Dispatch a user message to the appropriate Claude Code session.
   * Handles the 3-state machine: inactive → starting → connected.
   */
  async dispatch(
    message: IncomingMessage
  ): Promise<void> {
    const key = sessionKey("lark", message.chatId);
    let session = this.sessions.get(key);

    if (!session) {
      session = this.ensureSession(message);
    }

    // Update meta
    session.meta.lastActiveAt = new Date().toISOString();
    const firstLine = message.text.split("\n").find((l) => l.trim()) || "";
    session.meta.lastMessagePreview = firstLine.slice(0, 50);
    if (message.chatName) {
      session.meta.chatName = message.chatName;
    }
    saveSession(key, session.meta);

    const udsMsg: QueuedMessage = {
      chatId: message.chatId,
      content: message.text,
      meta: {
        chatId: message.chatId,
        senderId: message.senderId,
        messageId: message.messageId,
      },
    };

    switch (session.state) {
      case "inactive":
        session.messageQueue.push(udsMsg);
        this.startSession(session);
        break;

      case "starting":
        session.messageQueue.push(udsMsg);
        logger.debug("session starting, message queued", { key });
        break;

      case "connected":
        this.sendToChannel(session, udsMsg);
        break;
    }
  }

  createNewSession(chatId: string, workspace?: string): SessionMeta {
    const key = sessionKey("lark", chatId);
    const ws = workspace
      ? resolveWorkspacePath(workspace)
      : resolveWorkspacePath(this.config.defaultWorkspace);

    // Kill existing tmux session
    const existing = this.sessions.get(key);
    if (existing) {
      this.killTmux(key);
      if (existing.startingTimer) clearTimeout(existing.startingTimer);
    }
    this.sessions.delete(key);
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
      claudeSessionStarted: false,
      mentionRequired: true,
    };

    saveSession(key, meta);
    return meta;
  }

  async shutdown(): Promise<void> {
    for (const [key, session] of this.sessions) {
      if (session.startingTimer) clearTimeout(session.startingTimer);
      this.killTmux(key);
    }
    this.sessions.clear();
  }

  // --- Private ---

  private startSession(session: ActiveSession): void {
    const { key, meta } = session;

    // Ensure workspace exists
    fs.mkdirSync(meta.workspace, { recursive: true });

    // Ensure the global MCP config exists
    this.ensureMcpConfig();

    // Resume existing Claude session or create a new one with the stored UUID.
    const resume = meta.claudeSessionStarted;
    const claudeArgs = resume
      ? ["-r", meta.sessionId]
      : ["--session-id", meta.sessionId];

    if (this.config.claude.permissionMode === "bypassPermissions") {
      claudeArgs.push("--dangerously-skip-permissions");
    }

    if (this.config.claude.extraArgs.length > 0) {
      claudeArgs.push(...this.config.claude.extraArgs);
    }

    claudeArgs.push("--mcp-config", this.mcpConfigPath);
    claudeArgs.push(
      "--dangerously-load-development-channels",
      "server:cork-channel"
    );

    // CORK_SESSION_KEY is passed via env, inherited by Claude → MCP subprocess
    const claudeCmd =
      `CORK_SESSION_KEY='${key}' claude ${claudeArgs.join(" ")}`;
    const tmuxName = `${TMUX_PREFIX}${key}`;

    logger.info("starting tmux session", {
      key,
      tmuxName,
      workspace: meta.workspace,
      resume,
    });

    try {
      execSync(
        `tmux new-session -d -s "${tmuxName}" -x 200 -y 50 ` +
          `"cd '${meta.workspace}' && ${claudeCmd}"`,
        { stdio: "pipe", env: { ...process.env } }
      );
    } catch (err) {
      logger.error("failed to start tmux session", { key, err });
      session.state = "inactive";
      session.messageQueue = [];
      this.emit("error", key, `Failed to start Claude Code: ${(err as Error).message}`);
      return;
    }

    session.state = "starting";

    // Accept workspace trust dialog after a short delay
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t "${tmuxName}" Enter`, { stdio: "pipe" });
      } catch {
        // Session may have already passed the dialog
      }
    }, 3000);

    // Accept development channel confirmation
    setTimeout(() => {
      try {
        execSync(`tmux send-keys -t "${tmuxName}" Enter`, { stdio: "pipe" });
      } catch {
        // May not need it
      }
      session.channelEnterSentAt = Date.now();
      // If channel already registered before Enter, complete connection after delay
      if (session.pendingRegistration) {
        session.pendingRegistration = false;
        setTimeout(() => this.completeConnection(key), CHANNEL_READY_DELAY_MS);
      }
    }, 5000);

    // Starting timeout
    session.startingTimer = setTimeout(() => {
      if (session.state === "starting") {
        logger.warn("session starting timeout", { key });
        session.state = "inactive";
        const queued = session.messageQueue.length;
        session.messageQueue = [];
        this.killTmux(key);
        this.emit(
          "error",
          key,
          `Claude Code failed to start within ${STARTING_TIMEOUT_MS / 1000}s (${queued} message(s) dropped)`
        );
      }
    }, STARTING_TIMEOUT_MS);
  }

  private onChannelRegistered(key: string): void {
    const session = this.sessions.get(key);
    if (!session) {
      logger.warn("channel registered for unknown session", { key });
      return;
    }

    // Wait until 1.5s after the channel-confirmation Enter was sent.
    // If Enter has not been sent yet, defer until it is.
    if (session.channelEnterSentAt === undefined) {
      logger.debug("channel registered before Enter, deferring", { key });
      session.pendingRegistration = true;
      return;
    }

    const waitMs = Math.max(
      0,
      session.channelEnterSentAt + CHANNEL_READY_DELAY_MS - Date.now()
    );
    if (waitMs > 0) {
      logger.debug("channel registered, waiting for ready", { key, waitMs });
      setTimeout(() => this.completeConnection(key), waitMs);
    } else {
      this.completeConnection(key);
    }
  }

  private completeConnection(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.startingTimer) {
      clearTimeout(session.startingTimer);
      session.startingTimer = undefined;
    }

    session.state = "connected";

    // Mark Claude session as started so we use -r (resume) next time
    if (!session.meta.claudeSessionStarted) {
      session.meta.claudeSessionStarted = true;
      saveSession(key, session.meta);
    }

    logger.info("session connected", { key, queuedMessages: session.messageQueue.length });

    // Flush queued messages
    for (const msg of session.messageQueue) {
      this.sendToChannel(session, msg);
    }
    session.messageQueue = [];
  }

  private onChannelDisconnected(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;

    logger.info("channel disconnected, session → inactive", { key });
    session.state = "inactive";
    if (session.startingTimer) {
      clearTimeout(session.startingTimer);
      session.startingTimer = undefined;
    }
  }

  private sendToChannel(session: ActiveSession, msg: QueuedMessage): void {
    if (!this.udsServer) {
      logger.error("UDS server not set");
      return;
    }

    const sent = this.udsServer.sendToChannel(session.key, {
      type: "message",
      content: msg.content,
      meta: msg.meta,
    });

    if (!sent) {
      logger.warn("failed to send to channel, marking disconnected", {
        key: session.key,
      });
      session.state = "inactive";
    }
  }

  /**
   * Ensure the global MCP config file exists at ~/.cork/mcp-config.json.
   * This config is the same for all sessions — the per-session identity
   * (CORK_SESSION_KEY) is passed via environment variable instead.
   */
  private ensureMcpConfig(): void {
    if (fs.existsSync(this.mcpConfigPath)) return;

    const sockPath =
      process.env.CORK_SOCKET || paths.socketPath;
    const mcpConfig = {
      mcpServers: {
        "cork-channel": {
          command: "node",
          args: [this.channelServerPath],
          env: {
            CORK_SOCKET: sockPath,
          },
        },
      },
    };
    fs.mkdirSync(paths.corkDir, { recursive: true });
    fs.writeFileSync(this.mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  }

  private get mcpConfigPath(): string {
    return `${paths.corkDir}/mcp-config.json`;
  }

  private killTmux(key: string): void {
    const tmuxName = `${TMUX_PREFIX}${key}`;
    try {
      execSync(`tmux kill-session -t "${tmuxName}"`, { stdio: "pipe" });
      logger.info("killed tmux session", { tmuxName });
    } catch {
      // Session may not exist
    }
  }

  private resolveChannelServerPath(): string {
    const candidates: string[] = [];

    // Resolve relative to this module's location
    try {
      const url = new URL("../../dist/channel-mcp/server.js", import.meta.url);
      candidates.push(url.pathname);
    } catch {
      // import.meta.url not available
    }

    // Installed location
    candidates.push(`${paths.corkDir}/channel-mcp/server.js`);

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // Last resort — use the first candidate (will fail at runtime with a clear error)
    return candidates[0] || `${paths.corkDir}/channel-mcp/server.js`;
  }
}
