import net from "node:net";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export interface UdsMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * UDS client for channel MCP.
 * Connects to cork daemon's Unix socket and exchanges JSON-line messages.
 *
 * Events:
 * - "message" (msg: UdsMessage) — incoming message from cork
 * - "connected" () — connection established
 * - "disconnected" () — connection lost
 * - "error" (err: Error)
 */
export class UdsClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffer = "";
  private _connected = false;
  /** Requests waiting on a `command-result`, by requestId. */
  private pending = new Map<
    string,
    {
      resolve: (msg: UdsMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private sockPath: string,
    private sessionKey: string
  ) {
    super();
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.sockPath, () => {
        this._connected = true;
        // Register immediately upon connection
        this.send({ type: "register", corkSessionKey: this.sessionKey });
        this.emit("connected");
        resolve();
      });

      this.socket.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as UdsMessage;
            if (msg.type === "command-result" && typeof msg.requestId === "string") {
              const waiting = this.pending.get(msg.requestId);
              if (waiting) {
                this.pending.delete(msg.requestId);
                clearTimeout(waiting.timer);
                waiting.resolve(msg);
                continue;
              }
            }
            this.emit("message", msg);
          } catch {
            // ignore malformed lines
          }
        }
      });

      this.socket.on("end", () => {
        this._connected = false;
        this.failPending(new Error("cork disconnected"));
        this.emit("disconnected");
      });

      this.socket.on("error", (err) => {
        this._connected = false;
        this.failPending(err);
        if (!this.socket) {
          reject(err);
        } else {
          this.emit("error", err);
        }
      });
    });
  }

  send(msg: UdsMessage): void {
    if (!this.socket || !this._connected) {
      throw new Error("UDS client not connected");
    }
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  /**
   * Send a message that expects an answer — a `command` — and resolve with the
   * daemon's `command-result` for it. Rejects when nothing comes back in time:
   * the daemon answers a command synchronously or not at all, so a wait here
   * is a daemon that is down or busy, which the model should hear about rather
   * than sit on.
   */
  request(msg: UdsMessage, timeoutMs = 30_000): Promise<UdsMessage> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`no answer from cork within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send({ ...msg, requestId });
      } catch (err) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Nothing is coming for these any more; say so rather than let them time out. */
  private failPending(err: Error): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      waiting.reject(err);
    }
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      this._connected = false;
    }
  }
}
