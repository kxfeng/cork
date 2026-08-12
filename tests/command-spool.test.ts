import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueueCommand,
  CommandSpool,
  type SpoolCommand,
} from "../src/daemon/command-spool.js";

/**
 * The spool is the only path a short-lived CLI has to reach the running daemon,
 * so two properties matter most: a command is delivered exactly the way it was
 * enqueued, and a backlog left by a crash cannot silently replay itself.
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-spool-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait until `predicate` holds or time runs out — fs.watch is asynchronous.
 *
 * The deadline exists so a broken watcher fails the test instead of hanging
 * it. It is not an assertion about speed, and at two seconds it acted as one:
 * a full suite run once timed out here at 2012ms, having spent that long
 * waiting for a single fs event while twenty-nine other files ran alongside.
 * What actually delays the event is not established — saturating the CPU
 * deliberately did not reproduce it — so this is a looser guard rather than a
 * fix for a known cause.
 */
async function until(predicate: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("enqueueCommand", () => {
  it("writes one <id>.json carrying the envelope, no .tmp left behind", () => {
    enqueueCommand("prepare_session", { chatId: "oc_1" }, dir);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f-]+\.json$/);
    const body = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    expect(body).toEqual({ cmd: "prepare_session", args: { chatId: "oc_1" } });
  });
});

describe("CommandSpool consume", () => {
  it("delivers an enqueued command and removes the file", async () => {
    const seen: SpoolCommand[] = [];
    const spool = new CommandSpool((c) => void seen.push(c), dir);
    spool.start();
    try {
      enqueueCommand("send_message", { text: "hi" }, dir);
      await until(() => seen.length === 1);
      expect(seen[0]).toEqual({ cmd: "send_message", args: { text: "hi" } });
      // Consumed: the queue is empty again.
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".json"))).toEqual([]);
    } finally {
      spool.stop();
    }
  });

  it("does not double-handle a command", async () => {
    const seen: SpoolCommand[] = [];
    const spool = new CommandSpool((c) => void seen.push(c), dir);
    spool.start();
    try {
      enqueueCommand("ping", {}, dir);
      await until(() => seen.length === 1);
      // Give any duplicate fs.watch events time to (not) fire a second handler.
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toHaveLength(1);
    } finally {
      spool.stop();
    }
  });

  it("quarantines an unparseable file instead of looping on it", async () => {
    const spool = new CommandSpool(() => {}, dir);
    spool.start();
    try {
      // Write a bad command atomically so the watcher sees a complete file.
      const bad = path.join(dir, "bad.json");
      fs.writeFileSync(`${bad}.tmp`, "not json at all");
      fs.renameSync(`${bad}.tmp`, bad);
      await until(() => fs.existsSync(path.join(dir, ".failed", "bad.json")));
      // Moved out of the queue, so it will not be retried forever.
      expect(fs.existsSync(bad)).toBe(false);
    } finally {
      spool.stop();
    }
  });
});

describe("CommandSpool.discardStale", () => {
  it("drops a backlog left by a previous run without running it", async () => {
    // A crash left two commands and a half-written temp file behind.
    enqueueCommand("prepare_session", { chatId: "oc_old" }, dir);
    enqueueCommand("send_message", { text: "stale" }, dir);
    fs.writeFileSync(path.join(dir, "half.json.tmp"), '{"cmd":"x"}');

    const seen: SpoolCommand[] = [];
    const spool = new CommandSpool((c) => void seen.push(c), dir);
    spool.start(); // discardStale runs here
    try {
      // Nothing from the backlog is executed, and the queue is swept clean.
      await new Promise((r) => setTimeout(r, 100));
      expect(seen).toEqual([]);
      expect(fs.readdirSync(dir)).toEqual([]);

      // A command enqueued after startup is still delivered normally.
      enqueueCommand("live", {}, dir);
      await until(() => seen.length === 1);
      expect(seen[0].cmd).toBe("live");
    } finally {
      spool.stop();
    }
  });
});
