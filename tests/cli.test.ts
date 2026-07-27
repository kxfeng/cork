import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `cork session create` is what a skill runs to create and warm a session for a
 * freshly created group. It must enqueue a command the daemon will accept, with
 * mentionRequired pinned false so the group answers without an @mention.
 */
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-cli-"));
  process.env.CORK_DIR = dir; // paths.ts reads it at import time
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("cork session create", () => {
  it("enqueues a create_session command with mentionRequired false", async () => {
    vi.resetModules();
    const { sessionCreate } = await import("../src/commands/session.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined as never);

    sessionCreate({ channel: "lark", chat: "oc_z" });

    const files = fs.readdirSync(path.join(dir, "commands"));
    expect(files).toHaveLength(1);
    const body = JSON.parse(
      fs.readFileSync(path.join(dir, "commands", files[0]), "utf8")
    );
    expect(body).toEqual({
      cmd: "create_session",
      args: { channel: "lark", chatId: "oc_z", mentionRequired: false },
    });
  });
});

describe("cork send", () => {
  it("enqueues a send_message command with chat, text and mentions", async () => {
    vi.resetModules();
    const { sendCommand } = await import("../src/commands/send.js");
    vi.spyOn(console, "log").mockImplementation(() => undefined as never);

    sendCommand({ channel: "lark", chat: "oc_g", text: "@owner hi", at: ["ou_1"] });

    const files = fs.readdirSync(path.join(dir, "commands"));
    expect(files).toHaveLength(1);
    const body = JSON.parse(
      fs.readFileSync(path.join(dir, "commands", files[0]), "utf8")
    );
    expect(body).toEqual({
      cmd: "send_message",
      args: { channel: "lark", chatId: "oc_g", text: "@owner hi", at: ["ou_1"] },
    });
  });
});
