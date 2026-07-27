import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { paths } from "../config/paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("command-spool");

/** Subdir (under the queue) where an unparseable command is moved for inspection. */
const FAILED_SUBDIR = ".failed";

/** One queued command. `cmd` selects the handler; `args` is its payload. */
export interface SpoolCommand {
  cmd: string;
  args: Record<string, unknown>;
}

export type CommandHandler = (command: SpoolCommand) => void | Promise<void>;

/**
 * Enqueue a command for the running daemon.
 *
 * Writes `<id>.json.tmp` then renames it to `<id>.json`; rename is atomic within
 * a directory, so the daemon's watcher never observes a half-written file. This
 * is deliberately fire-and-forget: a short-lived CLI process enqueues and exits
 * immediately, without waiting for — or even requiring — the daemon to be up.
 *
 * A command left on disk while the daemon is DOWN is treated as stale and
 * discarded at next startup (see CommandSpool.discardStale). So "enqueue while
 * down" means "dropped", by design — these commands are immediate intent, not
 * durable work.
 */
export function enqueueCommand(
  cmd: string,
  args: Record<string, unknown> = {},
  dir: string = paths.commandsDir
): string {
  fs.mkdirSync(dir, { recursive: true });
  const id = uuidv4();
  const finalPath = path.join(dir, `${id}.json`);
  fs.writeFileSync(`${finalPath}.tmp`, JSON.stringify({ cmd, args }));
  fs.renameSync(`${finalPath}.tmp`, finalPath);
  return id;
}

/**
 * Directory-as-queue: one file per command under ~/.cork/commands. The daemon
 * owns a single CommandSpool; a CLI enqueues with `enqueueCommand` above.
 *
 * Consume order is not guaranteed (fs.watch/readdir impose none), which is fine
 * — commands are independent. Delivery is at-most-once: a file is unlinked
 * before its handler runs, so a handler that throws (or a crash mid-handle)
 * drops that command rather than replaying it. That matches the semantics of
 * what travels here (prepare a session, send one message), where a duplicate is
 * worse than a miss.
 */
export class CommandSpool {
  private watcher?: fs.FSWatcher;
  // Filenames currently being consumed — fs.watch may fire several events for
  // one file, and this keeps a later event from double-handling it.
  private inFlight = new Set<string>();

  constructor(
    private handler: CommandHandler,
    private dir: string = paths.commandsDir
  ) {}

  start(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    this.discardStale();
    this.watcher = fs.watch(this.dir, (_event, filename) => {
      if (!filename) return;
      // Only top-level <id>.json files are commands. Skip .tmp (mid-write) and
      // guard against any recursive/subdir event for the .failed quarantine.
      if (filename.includes(path.sep) || !filename.endsWith(".json")) return;
      void this.consume(filename);
    });
    logger.info("command spool watching", { dir: this.dir });
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
  }

  /**
   * Drop anything left in the queue from a previous run. A command enqueued
   * while the daemon was down is stale by the time it restarts — the group may
   * be abandoned, a queued message long overdue — and replaying it could warm a
   * session for a dead chat or post something out of date. So the backlog (plus
   * any half-written .tmp files) is discarded, never executed.
   */
  private discardStale(): void {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const stale = entries.filter(
      (f) => f.endsWith(".json") || f.endsWith(".tmp")
    );
    if (stale.length === 0) return;
    logger.warn("discarding stale commands from a previous run", {
      count: stale.length,
      files: stale,
    });
    for (const f of stale) {
      try {
        fs.unlinkSync(path.join(this.dir, f));
      } catch {
        /* already gone */
      }
    }
  }

  private async consume(filename: string): Promise<void> {
    if (this.inFlight.has(filename)) return;
    this.inFlight.add(filename);
    const full = path.join(this.dir, filename);

    let raw: string;
    try {
      raw = fs.readFileSync(full, "utf8");
    } catch {
      // Consumed by an earlier event, or we caught the rename mid-flight.
      this.inFlight.delete(filename);
      return;
    }

    const command = parseCommand(raw);
    if (!command) {
      logger.warn("unparseable command file, quarantining", { filename });
      this.quarantine(full, filename);
      this.inFlight.delete(filename);
      return;
    }

    // Remove before handling: a handler that throws must not leave a file the
    // next event would re-process.
    try {
      fs.unlinkSync(full);
    } catch {
      /* already gone */
    }
    this.inFlight.delete(filename);

    try {
      await this.handler(command);
    } catch (err) {
      logger.error("command handler failed", { cmd: command.cmd, err });
    }
  }

  private quarantine(full: string, filename: string): void {
    const dir = path.join(this.dir, FAILED_SUBDIR);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(full, path.join(dir, filename));
    } catch {
      try {
        fs.unlinkSync(full);
      } catch {
        /* give up */
      }
    }
  }
}

function parseCommand(raw: string): SpoolCommand | undefined {
  try {
    const parsed = JSON.parse(raw) as { cmd?: unknown; args?: unknown };
    if (typeof parsed.cmd !== "string" || !parsed.cmd) return undefined;
    const args =
      parsed.args && typeof parsed.args === "object"
        ? (parsed.args as Record<string, unknown>)
        : {};
    return { cmd: parsed.cmd, args };
  } catch {
    return undefined;
  }
}
