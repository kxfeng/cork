import { v4 as uuidv4 } from "uuid";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { loadCorkEnv } from "../config/env-file.js";
import { getLogger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
  // Two independent readiness gates. Connection completes only when both
  // are true. Decoupled because either event can in principle land first,
  // and we never want to flush queued messages before the dialog is gone.
  channelRegistered: boolean;
  dialogDismissed: boolean;
  pendingReactions: PendingReaction[];
}

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

  constructor(private config: CorkConfig) {
    super();
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

    session = {
      key,
      meta,
      state: "inactive",
      messageQueue: [],
      channelRegistered: false,
      dialogDismissed: false,
      pendingReactions: [],
    };
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

    // ~/.cork/env values augment the daemon's env so shell-only exports
    // (e.g. ANTHROPIC_MODEL) reach claude even though launchd does not
    // source the user's shell rc files.
    const corkEnv = loadCorkEnv();

    try {
      execSync(
        `tmux new-session -d -s "${tmuxName}" -x 200 -y 50 ` +
          `"cd '${meta.workspace}' && ${claudeCmd}"`,
        { stdio: "pipe", env: { ...process.env, ...corkEnv } }
      );
    } catch (err) {
      logger.error("failed to start tmux session", { key, err });
      session.state = "inactive";
      session.messageQueue = [];
      this.emit("error", key, `Failed to start Claude Code: ${(err as Error).message}`);
      return;
    }

    session.state = "starting";
    session.channelRegistered = false;
    session.dialogDismissed = false;

    // Poll the tmux pane and dismiss the development channel confirmation
    // dialog. Sends Enter while the dialog text is on screen and stops once
    // it disappears, so we don't fire stray Enters into the main prompt.
    this.pollAndDismissChannelDialog(session, tmuxName);

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
    session.channelRegistered = true;
    this.tryCompleteConnection(session);
  }

  /**
   * Complete connection only when both readiness gates are satisfied:
   * the dev-channel dialog has been dismissed AND the channel MCP has
   * registered over UDS. Either event may fire first.
   */
  private tryCompleteConnection(session: ActiveSession): void {
    if (session.state !== "starting") return;
    if (!session.channelRegistered || !session.dialogDismissed) {
      logger.debug("waiting for both gates", {
        key: session.key,
        channelRegistered: session.channelRegistered,
        dialogDismissed: session.dialogDismissed,
      });
      return;
    }
    this.completeConnection(session.key);
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

    if (sent) {
      logger.debug("sent message to channel", {
        key: session.key,
        contentLen: msg.content.length,
      });
    } else {
      logger.warn("failed to send to channel, marking disconnected", {
        key: session.key,
      });
      session.state = "inactive";
    }
  }

  /**
   * Watch the tmux pane for the dev-channel confirmation dialog and dismiss
   * it by sending Enter. Stops once the dialog text is no longer visible, so
   * stray Enters never reach the main prompt.
   */
  private pollAndDismissChannelDialog(
    session: ActiveSession,
    tmuxName: string
  ): void {
    // Match the prompt rendered for `--dangerously-load-development-channels`.
    // Two strings unique to this dialog — header + option label.
    const DIALOG_PATTERN =
      /Loading development channels|I am using this for local development/;
    const POLL_INTERVAL_MS = 500;
    const POLL_TIMEOUT_MS = 15_000;
    const POLL_START_DELAY_MS = 1000;

    const key = session.key;
    const startedAt = Date.now();
    let dialogSeen = false;

    const markDismissed = () => {
      if (session.dialogDismissed) return;
      session.dialogDismissed = true;
      this.tryCompleteConnection(session);
    };

    const tick = () => {
      if (session.state !== "starting") return;

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        logger.warn("channel dialog poll timeout, proceeding", {
          key,
          dialogSeen,
        });
        markDismissed();
        return;
      }

      let pane = "";
      try {
        pane = execSync(`tmux capture-pane -t "${tmuxName}" -p`, {
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        // tmux pane not ready yet; keep polling
      }

      if (DIALOG_PATTERN.test(pane)) {
        dialogSeen = true;
        try {
          execSync(`tmux send-keys -t "${tmuxName}" Enter`, { stdio: "pipe" });
        } catch {
          // ignore
        }
        setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      if (dialogSeen) {
        markDismissed();
        return;
      }

      setTimeout(tick, POLL_INTERVAL_MS);
    };

    setTimeout(tick, POLL_START_DELAY_MS);
  }

  /**
   * Write ~/.cork/mcp-config.json. Resolves the bundled channel-mcp script
   * relative to this module's own location, so it works regardless of
   * where cork is installed and does not depend on PATH. Called once at
   * daemon startup so the config always reflects the running cork install.
   * Per-session identity (CORK_SESSION_KEY) is passed via env on the tmux
   * command line, not in this file.
   */
  writeMcpConfig(): void {
    const sockPath = process.env.CORK_SOCKET || paths.socketPath;
    const channelServerPath = path.join(
      __dirname,
      "../channel-mcp/server.js"
    );
    const mcpConfig = {
      mcpServers: {
        "cork-channel": {
          command: "node",
          args: [channelServerPath],
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
}
