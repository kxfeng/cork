import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findScriptCommand,
  runScriptCommand,
} from "../src/dispatcher/script-commands.js";
import type { IncomingMessage } from "../src/channels/types.js";

/**
 * A user command is arbitrary code the daemon runs on a chat message, so the
 * two things worth pinning down are what it is allowed to see (the contract
 * people write scripts against) and what it is not allowed to do to the daemon
 * (hang it, flood a chat, or run at all when the file is not trustworthy).
 */
let dir: string;

const message: IncomingMessage = {
  channel: "lark",
  chatId: "oc_x",
  chatType: "group",
  chatName: "Cork · Test",
  senderId: "ou_sender",
  messageId: "om_1",
  text: "/demo hello world",
};

function write(name: string, body: string, mode = 0o755): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

function run(name: string, args = "", timeoutMs?: number) {
  const file = path.join(dir, name);
  return runScriptCommand(name, file, args, message, "lark_oc_x", dir, timeoutMs);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-cmds-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("findScriptCommand", () => {
  it("finds an executable named after the command", () => {
    const file = write("deploy", "#!/bin/sh\n");
    expect(findScriptCommand("deploy", dir)).toBe(file);
  });

  it("ignores a file with no executable bit", () => {
    // Otherwise a stray note or a leftover .json would be spawned.
    write("deploy", "#!/bin/sh\n", 0o644);
    expect(findScriptCommand("deploy", dir)).toBeNull();
  });

  it("ignores a file anyone else can write", () => {
    // It runs as the daemon user; a file others can edit is theirs, not ours.
    write("deploy", "#!/bin/sh\n", 0o777);
    expect(findScriptCommand("deploy", dir)).toBeNull();
  });

  it("ignores a directory", () => {
    fs.mkdirSync(path.join(dir, "deploy"));
    expect(findScriptCommand("deploy", dir)).toBeNull();
  });

  it("returns null for a command with no file at all", () => {
    expect(findScriptCommand("nope", dir)).toBeNull();
  });

  it.each(["../escape", "sub/deploy", "Deploy", ".hidden", ""])(
    "refuses %s as a command name",
    (name) => {
      expect(findScriptCommand(name, dir)).toBeNull();
    }
  );
});

describe("runScriptCommand", () => {
  it("posts stdout back", async () => {
    write("demo", '#!/bin/sh\necho "done"\n');
    expect((await run("demo")).reply).toBe("done");
  });

  it("posts nothing when the command is silent", async () => {
    // Commands that speak for themselves (sending to another chat) end here.
    write("demo", "#!/bin/sh\nexit 0\n");
    expect((await run("demo")).reply).toBe("");
  });

  it("passes everything after the command as one argument", async () => {
    // Not split on spaces: `/new-chat my project` must arrive whole.
    write("demo", '#!/bin/sh\nprintf "[%s]" "$1"\n');
    expect((await run("demo", "my project")).reply).toBe("[my project]");
  });

  it("hands the message context over as CORK_* variables", async () => {
    write(
      "demo",
      '#!/bin/sh\necho "$CORK_CHANNEL $CORK_CHAT_ID $CORK_SENDER_ID $CORK_SESSION_KEY $CORK_CHAT_NAME"\n'
    );
    expect((await run("demo")).reply).toBe(
      "lark oc_x ou_sender lark_oc_x Cork · Test"
    );
  });

  it("hands the whole message over as JSON on stdin", async () => {
    // The escape hatch for fields the CORK_* contract does not name.
    write("demo", "#!/bin/sh\ncat\n");
    expect(JSON.parse((await run("demo")).reply)).toEqual(message);
  });

  it("runs in the workspace", async () => {
    write("demo", "#!/bin/sh\npwd\n");
    expect(fs.realpathSync((await run("demo")).reply)).toBe(
      fs.realpathSync(dir)
    );
  });

  it("says what the command said, not what cork calls it", async () => {
    // The chat already shows the message that ran this; repeating the command
    // name back and burying its own words under an exit code is noise.
    write("demo", '#!/bin/sh\necho "boom" >&2\nexit 3\n');
    const { reply } = await run("demo");
    expect(reply).toBe("❌ boom");
  });

  it("falls back to the exit code when the command said nothing", async () => {
    write("demo", "#!/bin/sh\nexit 3\n");
    expect((await run("demo")).reply).toBe("❌ failed (exit 3)");
  });

  it("keeps stdout out of the failure report", async () => {
    // Half-finished output on a failed run reads as if it had worked.
    write("demo", '#!/bin/sh\necho "half done"\nexit 1\n');
    expect((await run("demo")).reply).not.toContain("half done");
  });

  it("truncates a flood instead of posting all of it", async () => {
    write("demo", "#!/bin/sh\nyes ABCDEFGH | head -5000\n");
    const { reply } = await run("demo");
    expect(reply).toContain("(truncated)");
    expect(reply.length).toBeLessThan(9 * 1024);
  });

  it("kills a command that hangs, and says so", async () => {
    // Commands run inside the chat's queue, so one that never exits would
    // wedge every later message in that chat.
    write("demo", "#!/bin/sh\nsleep 30\n");
    const { reply } = await run("demo", "", 300);
    expect(reply).toBe("❌ timed out after 0.3s");
  });

  it("does not wait on something the command left running", async () => {
    // A backgrounded child inherits our stdout pipe, so waiting for the pipe
    // to close would hang here for 30s on a command that already exited.
    write("demo", '#!/bin/sh\nsleep 30 &\necho "done"\n');
    expect((await run("demo")).reply).toBe("done");
  }, 5000);

  it("reports a command that cannot be executed at all", async () => {
    // Nothing is written: the file does not exist.
    const { reply } = await run("ghost");
    expect(reply).toContain("could not run");
  });
});
