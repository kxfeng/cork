import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "../src/channels/types.js";

/**
 * Where a user command meets the dispatcher. The unit tests next door cover
 * running one; what matters here is the routing around it — that a script
 * answers instead of the model, that anything without a script still reaches
 * the model untouched, and that a script cannot take over a built-in.
 */
let dir: string;
let sent: Array<{ chatId: string; content: string; opts: unknown }>;

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return import("../src/dispatcher/commands.js");
}

const channel = {
  sendReply: async (chatId: string, content: string, opts?: unknown) => {
    sent.push({ chatId, content, opts });
  },
} as never;

/** Enough of a SessionManager for the command path: it only reads. */
const sessionManager = {
  getSession: () => undefined,
  // No session for this chat yet — the script gets an empty CORK_SESSION_KEY.
  sessionKeyFor: () => undefined,
  defaultWorkspace: () => os.tmpdir(),
} as never;

const message = (text: string, threadId?: string): IncomingMessage => ({
  channel: "lark",
  chatId: "oc_x",
  chatType: "group",
  senderId: "ou_sender",
  messageId: "om_1",
  text,
  ...(threadId ? { threadId } : {}),
});

function write(name: string, body: string, mode = 0o755): void {
  const file = path.join(dir, "commands", name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-dispatch-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "commands"), { recursive: true });
  sent = [];
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("handleCommand → user commands", () => {
  it("answers with the script's output instead of waking the model", async () => {
    write("demo", '#!/bin/sh\necho "ran"\n');
    const { handleCommand } = await load();

    const res = await handleCommand(channel, message("/demo"), sessionManager);

    expect(res.handled).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toBe("ran");
  });

  it("passes the rest of the line through as one argument", async () => {
    write("demo", '#!/bin/sh\nprintf "[%s]" "$1"\n');
    const { handleCommand } = await load();

    await handleCommand(channel, message("/demo a b  c"), sessionManager);

    expect(sent[0].content).toBe("[a b  c]");
  });

  it("leaves an unknown slash message to the model", async () => {
    const { handleCommand } = await load();

    const res = await handleCommand(
      channel,
      message("/nothing-here"),
      sessionManager
    );

    expect(res.handled).toBe(false);
    expect(sent).toEqual([]);
  });

  it("leaves ordinary text alone", async () => {
    write("demo", '#!/bin/sh\necho "ran"\n');
    const { handleCommand } = await load();

    const res = await handleCommand(
      channel,
      message("what does /demo do?"),
      sessionManager
    );

    expect(res.handled).toBe(false);
    expect(sent).toEqual([]);
  });

  it("cannot be shadowed by a script named after a built-in", async () => {
    // /status has to keep working even if a file called `status` is dropped in.
    write("status", '#!/bin/sh\necho "hijacked"\n');
    const { handleCommand } = await load();

    const res = await handleCommand(channel, message("/status"), sessionManager);

    expect(res.handled).toBe(true);
    expect(sent[0].content).not.toContain("hijacked");
    expect(sent[0].content).toContain("Session Status");
  });

  it("posts nothing when the script is silent, and still handles it", async () => {
    // The chat it was sent from is not where the result lives — /new-chat
    // moves the conversation to a group that is about to appear. The ack
    // reaction going on and coming off is the only trace it leaves.
    write("demo", "#!/bin/sh\nexit 0\n");
    const { handleCommand } = await load();

    const res = await handleCommand(channel, message("/demo"), sessionManager);

    expect(res.handled).toBe(true);
    expect(sent).toEqual([]);
  });

  it("answers inside the thread it was called from", async () => {
    write("demo", '#!/bin/sh\necho "ran"\n');
    const { handleCommand } = await load();

    await handleCommand(channel, message("/demo", "omt_1"), sessionManager);

    expect(sent[0].opts).toMatchObject({ replyInThread: true });
  });
});
