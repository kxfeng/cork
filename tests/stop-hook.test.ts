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
  env: Record<string, string> = {}
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
    p.stdin.write(JSON.stringify({ transcript_path: transcriptPath }));
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
