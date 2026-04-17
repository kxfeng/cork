import net from "node:net";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { getLogger } from "../logger.js";

const logger = getLogger("uds-server");

/**
 * Messages sent over UDS, one JSON object per line.
 */
export interface UdsMessage {
  type: string;
  [key: string]: unknown;
}

export interface RegisterMessage extends UdsMessage {
  type: "register";
  corkSessionKey: string;
}

export interface ReplyMessage extends UdsMessage {
  type: "reply";
  corkSessionKey: string;
  content: string;
}

export interface PermissionRequestMessage extends UdsMessage {
  type: "permission_request";
  corkSessionKey: string;
  toolName: string;
  description: string;
  requestId: string;
}

export interface PermissionVerdictMessage extends UdsMessage {
  type: "permission_verdict";
  requestId: string;
  behavior: "allow" | "deny";
}

interface ChannelConnection {
  socket: net.Socket;
  sessionKey: string;
}

/**
 * UDS server for cork daemon.
 * Manages channel MCP connections and routes messages.
 *
 * Events:
 * - "register" (sessionKey: string, conn: ChannelConnection)
 * - "reply" (msg: ReplyMessage)
 * - "permission_request" (msg: PermissionRequestMessage)
 * - "disconnect" (sessionKey: string)
 */
export class UdsServer extends EventEmitter {
  private server: net.Server | null = null;
  private connections = new Map<string, ChannelConnection>();

  constructor(private sockPath: string) {
    super();
  }

  async start(): Promise<void> {
    // Clean up stale socket file
    if (fs.existsSync(this.sockPath)) {
      fs.unlinkSync(this.sockPath);
    }

    this.server = net.createServer({ allowHalfOpen: false }, (socket) => {
      this.handleConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.sockPath, () => {
        logger.info("UDS server listening", { path: this.sockPath });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Close all connections
    for (const [, conn] of this.connections) {
      conn.socket.destroy();
    }
    this.connections.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up socket file
    if (fs.existsSync(this.sockPath)) {
      fs.unlinkSync(this.sockPath);
    }
  }

  /**
   * Send a message to a connected channel by session key.
   */
  sendToChannel(sessionKey: string, msg: UdsMessage): boolean {
    const conn = this.connections.get(sessionKey);
    if (!conn) return false;
    try {
      conn.socket.write(JSON.stringify(msg) + "\n");
      return true;
    } catch (err) {
      logger.warn("failed to send to channel", { sessionKey, err });
      return false;
    }
  }

  /**
   * Check if a channel is connected for a given session key.
   */
  isConnected(sessionKey: string): boolean {
    return this.connections.has(sessionKey);
  }

  private handleConnection(socket: net.Socket): void {
    let sessionKey = "";
    let buffer = "";

    logger.debug("new UDS connection");

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as UdsMessage;
          this.handleMessage(socket, msg, sessionKey, (key) => {
            sessionKey = key;
          });
        } catch (err) {
          logger.warn("invalid JSON from UDS client", { line: line.slice(0, 200) });
        }
      }
    });

    socket.on("end", () => {
      if (sessionKey) {
        this.connections.delete(sessionKey);
        this.emit("disconnect", sessionKey);
        logger.info("channel disconnected", { sessionKey });
      }
    });

    socket.on("error", (err) => {
      logger.warn("UDS connection error", { err, sessionKey });
      if (sessionKey) {
        this.connections.delete(sessionKey);
        this.emit("disconnect", sessionKey);
      }
    });
  }

  private handleMessage(
    socket: net.Socket,
    msg: UdsMessage,
    currentKey: string,
    setKey: (key: string) => void
  ): void {
    switch (msg.type) {
      case "register": {
        const regMsg = msg as RegisterMessage;
        const key = regMsg.corkSessionKey;
        if (!key) {
          logger.warn("register message missing corkSessionKey");
          return;
        }
        // Close existing connection for this key if any
        const existing = this.connections.get(key);
        if (existing) {
          existing.socket.destroy();
        }
        const conn: ChannelConnection = { socket, sessionKey: key };
        this.connections.set(key, conn);
        setKey(key);
        logger.info("channel registered", { sessionKey: key });
        this.emit("register", key, conn);
        break;
      }
      case "reply": {
        this.emit("reply", msg as ReplyMessage);
        break;
      }
      case "permission_request": {
        this.emit("permission_request", msg as PermissionRequestMessage);
        break;
      }
      default:
        logger.debug("unknown UDS message type", { type: msg.type });
    }
  }
}
