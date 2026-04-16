import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { getLogger } from "../logger.js";

const logger = getLogger("claude-process");

export interface ClaudeEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  [key: string]: unknown;
}

export interface ClaudeProcessOptions {
  workspace: string;
  sessionId: string;
  resume: boolean;
  permissionMode?: "bypassPermissions" | "default";
  extraArgs?: string[];
}

/**
 * Persistent Claude Code subprocess.
 * Spawns once, handles multiple conversation turns via stdin/stdout.
 * Matches the approach used by the official Agent SDK internally.
 */
export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private _alive = false;
  private _sessionId: string;

  constructor(sessionId: string) {
    super();
    this._sessionId = sessionId;
  }

  get alive(): boolean {
    return this._alive;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  spawn(opts: ClaudeProcessOptions): void {
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--input-format", "stream-json",
    ];

    if (opts.resume) {
      args.push("-r", opts.sessionId);
    } else {
      args.push("--session-id", opts.sessionId);
    }

    if (opts.permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }

    if (opts.extraArgs) {
      args.push(...opts.extraArgs);
    }

    logger.info(
      "spawning persistent claude process",
      { workspace: opts.workspace, resume: opts.resume, sessionId: opts.sessionId }
    );

    this.proc = spawn("claude", args, {
      cwd: opts.workspace,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this._alive = true;

    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as ClaudeEvent;

        // Track session ID from events
        if (event.session_id) {
          this._sessionId = event.session_id;
        }

        this.emit("event", event);
      } catch {
        logger.warn("non-JSON line from claude", { line: line.slice(0, 200) });
      }
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.debug("claude stderr", { stderr: text });
    });

    this.proc.on("exit", (code, signal) => {
      this._alive = false;
      logger.info("claude process exited", { code, signal });
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      this._alive = false;
      logger.error("claude process error", { err });
      this.emit("error", err);
    });
  }

  /**
   * Send a user message to the persistent process.
   * Uses the same format as the Agent SDK.
   */
  sendMessage(text: string): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Claude process stdin not writable");
    }
    const msg = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    this.proc.stdin.write(msg + "\n");
  }

  kill(): void {
    if (this.proc && this._alive) {
      this.proc.kill("SIGTERM");
    }
  }
}
