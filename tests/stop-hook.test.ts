import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for the Stop hook: spawn the built script exactly the way
 * Claude Code does (hook JSON on stdin, decision JSON on stdout).
 */
const HOOK = path.resolve(__dirname, "../dist/hooks/stop-hook.js");

const CHANNEL_ROW = (text: string) =>
  JSON.stringify({
    type: "user",
    isMeta: true,
    message: {
      role: "user",
      content: `<channel source="cork-channel" chatId="oc_x" senderId="ou_x" messageId="om_x">\n${text}\n</channel>`,
    },
  });

const REPLY_ROW = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [
      { type: "tool_use", name: "mcp__cork-channel__reply", input: { text: "hi" } },
    ],
  },
});

const TEXT_ROW = JSON.stringify({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
});

/** Run the hook against a transcript; resolves with its stdout. */
function runHook(
  transcriptPath: string,
  env: Record<string, string> = {},
  extraInput: Record<string, unknown> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("close", () => resolve(out));
    p.stdin.write(
      JSON.stringify({ transcript_path: transcriptPath, ...extraInput })
    );
    p.stdin.end();
  });
}

const blocked = (stdout: string) => stdout.includes('"block"');

describe("stop-hook", () => {
  let dir: string;
  let transcript: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-hook-test-"));
    transcript = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("allows the turn when the reply is already in the transcript", async () => {
    fs.writeFileSync(
      transcript,
      [CHANNEL_ROW("hello"), REPLY_ROW, TEXT_ROW].join("\n") + "\n"
    );
    expect(blocked(await runHook(transcript))).toBe(false);
  });

  it("blocks when the model really never replied", async () => {
    fs.writeFileSync(transcript, [CHANNEL_ROW("hello"), TEXT_ROW].join("\n") + "\n");
    expect(blocked(await runHook(transcript))).toBe(true);
  });

  /**
   * The regression this hook was rewritten for: Claude Code fires the hook
   * before the turn's rows are flushed, so the reply's tool_use line can land
   * *after* the hook first reads the file. Blocking on that first read produced
   * a spurious "you did not reply" and a duplicate message to the user.
   */
  it("waits for a reply that is still being flushed", async () => {
    fs.writeFileSync(transcript, CHANNEL_ROW("hello") + "\n");

    const running = runHook(transcript);
    // Land the reply well after the hook's first read (POLL_MS is 150ms).
    setTimeout(() => {
      fs.appendFileSync(transcript, REPLY_ROW + "\n" + TEXT_ROW + "\n");
    }, 600);

    expect(blocked(await running)).toBe(false);
  }, 10_000);
});

/**
 * An autopilot run goes on for hours over many turns. Making every one of them post to
 * the chat would bury the user, so the hook stands down while one is running and
 * the cork-autopilot skill asks the model to report at meaningful points instead.
 * Cork's watcher, not this hook, is what keeps an autopilot run moving.
 */
describe("stop-hook during an autopilot run", () => {
  let dir: string;
  let transcript: string;

  const noReply = () =>
    fs.writeFileSync(transcript, [CHANNEL_ROW("hello"), TEXT_ROW].join("\n") + "\n");

  function writeAutopilot(state: string): void {
    const file = path.join(dir, "sessions", "sess-1", "AUTOPILOT.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ state }));
  }

  const env = () => ({ CORK_DIR: dir, CORK_SESSION_KEY: "sess-1" });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-hook-lt-"));
    transcript = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("stands down while a task is running", async () => {
    noReply();
    writeAutopilot("running");
    expect(blocked(await runHook(transcript, env()))).toBe(false);
  });

  it("still blocks once the task has stopped", async () => {
    noReply();
    writeAutopilot("stopped");
    expect(blocked(await runHook(transcript, env()))).toBe(true);
  });

  it("blocks when there is no record at all", async () => {
    // The default has to be "not running": being wrong that way costs one
    // redundant nudge, while the other way silences an ordinary chat.
    noReply();
    expect(blocked(await runHook(transcript, env()))).toBe(true);
  });

  it("blocks when the record is corrupt", async () => {
    noReply();
    const file = path.join(dir, "sessions", "sess-1", "AUTOPILOT.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ truncated");
    expect(blocked(await runHook(transcript, env()))).toBe(true);
  });

  it("blocks when the pane has no session key to look one up by", async () => {
    noReply();
    writeAutopilot("running");
    expect(blocked(await runHook(transcript, { CORK_DIR: dir }))).toBe(true);
  });
});

/**
 * A turn that ends without a reply leaves cork's ack emoji on the message that
 * started it: the daemon sees replies, not turn boundaries, so it cannot tell
 * "said nothing" from "still working". This hook runs exactly at that boundary,
 * and reports the silence through the command spool so the emoji comes off.
 *
 * Only on the second pass — the first one nudges, and a model that answers the
 * nudge has not been silent after all.
 */
describe("stop-hook reporting a silent turn", () => {
  let dir: string;
  let transcript: string;

  const env = () => ({ CORK_DIR: dir, CORK_SESSION_KEY: "sess-1" });

  /** Spool commands the hook wrote, parsed. */
  const spooled = (): Array<{ cmd: string; args: Record<string, unknown> }> => {
    const spool = path.join(dir, "spool");
    if (!fs.existsSync(spool)) return [];
    return fs
      .readdirSync(spool)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(spool, f), "utf8")));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-hook-silent-"));
    transcript = path.join(dir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("asks the daemon to clear the acks", async () => {
    fs.writeFileSync(transcript, [CHANNEL_ROW("for the other bot"), TEXT_ROW].join("\n") + "\n");

    const out = await runHook(transcript, env(), { stop_hook_active: true });

    // Second pass never blocks — it only reports.
    expect(blocked(out)).toBe(false);
    expect(spooled()).toEqual([
      { cmd: "clear_acks", args: { sessionKey: "sess-1" } },
    ]);
  });

  it("says nothing when the model answered the nudge", async () => {
    // Blocked once, then replied: the ack comes off through the reply path,
    // and reporting silence here would clear acks for a turn that spoke.
    fs.writeFileSync(transcript, [CHANNEL_ROW("hi"), REPLY_ROW].join("\n") + "\n");

    await runHook(transcript, env(), { stop_hook_active: true });

    expect(spooled()).toEqual([]);
  });

  it("does not report on the first pass", async () => {
    // The first pass nudges instead; the model may still be about to reply.
    fs.writeFileSync(transcript, [CHANNEL_ROW("hi"), TEXT_ROW].join("\n") + "\n");

    const out = await runHook(transcript, env());

    expect(blocked(out)).toBe(true);
    expect(spooled()).toEqual([]);
  });

  it("stays quiet when it does not know which session it is", async () => {
    // Without CORK_SESSION_KEY there is nothing to name in the command, and a
    // malformed one would only be dropped by the daemon.
    //
    // Blanked rather than omitted: the hook inherits this process's
    // environment, and these tests are themselves run from a cork session, so
    // leaving the key out would let the real one through.
    fs.writeFileSync(transcript, [CHANNEL_ROW("hi"), TEXT_ROW].join("\n") + "\n");

    await runHook(
      transcript,
      { CORK_DIR: dir, CORK_SESSION_KEY: "" },
      { stop_hook_active: true }
    );

    expect(spooled()).toEqual([]);
  });
});
