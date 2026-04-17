import net from "node:net";
import { EventEmitter } from "node:events";

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
            this.emit("message", msg);
          } catch {
            // ignore malformed lines
          }
        }
      });

      this.socket.on("end", () => {
        this._connected = false;
        this.emit("disconnected");
      });

      this.socket.on("error", (err) => {
        this._connected = false;
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

  disconnect(): void {
    if (this.socket) {
      this.socket.end();
      this.socket = null;
      this._connected = false;
    }
  }
}
