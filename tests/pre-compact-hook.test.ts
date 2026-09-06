import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * End-to-end tests for the PreCompact hook: spawn the built script the way
 * Claude Code does and read its stdout, which claude appends verbatim to its
 * own summarisation prompt.
 *
 * The contract has one hard rule in both directions. Printing something for a
 * session that is not running autopilot would steer every compaction on the
 * machine toward files that do not exist; printing nothing for one that is
 * loses the only chance to say what the summary must keep. Everything below
 * is that rule.
 */
const HOOK = path.resolve(__dirname, "../dist/hooks/pre-compact-hook.js");

const KEY = "sess-precompact";

/** Run the hook with cork's env, as claude would; resolves with its stdout. */
function runHook(
  env: Record<string, string> = {},
  input: Record<string, unknown> = {
    hook_event_name: "PreCompact",
    trigger: "auto",
    custom_instructions: null,
  }
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [HOOK], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", reject);
    p.on("close", (code) => resolve({ out, code }));
    p.stdin.write(JSON.stringify(input));
    p.stdin.end();
  });
}

describe("pre-compact-hook", () => {
  let dir: string;
  let sessionDir: string;

  const writeRecord = (state: string) =>
    fs.writeFileSync(
      path.join(sessionDir, "AUTOPILOT.json"),
      JSON.stringify({ state })
    );

  const env = () => ({ CORK_DIR: dir, CORK_SESSION_KEY: KEY });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-precompact-test-"));
    sessionDir = path.join(dir, "sessions", KEY);
    fs.mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("tells the summariser what to keep while a run is live", async () => {
    writeRecord("running");
    const { out, code } = await runHook(env());

    expect(code).toBe(0);
    // The absolute path matters more than the wording: the model reading the
    // summary has only the summary, and this is what it hands to Read.
    expect(out).toContain(path.join(sessionDir, "PROJECT.md"));
    expect(out).toContain("GOAL.md");
    expect(out).toContain("acceptance conditions verbatim");
  });

  it("covers a run whose goal is still registering", async () => {
    // GOAL.md and PROJECT.md are both written by then, and a compaction
    // landing in that window is exactly when they are worth keeping.
    writeRecord("starting");
    expect((await runHook(env())).out).toContain("PROJECT.md");
  });

  it("says nothing once the run is being stopped", async () => {
    // `/goal clear` has been typed by then; steering the summary toward a goal
    // on its way out would preserve the wrong thing.
    writeRecord("stopping");
    expect((await runHook(env())).out).toBe("");
  });

  it("says nothing for a session that has never run one", async () => {
    writeRecord("idle");
    expect((await runHook(env())).out).toBe("");
  });

  it("says nothing when there is no record at all", async () => {
    expect((await runHook(env())).out).toBe("");
  });

  it("says nothing, and still exits 0, when the record is corrupt", async () => {
    fs.writeFileSync(path.join(sessionDir, "AUTOPILOT.json"), "{ not json");
    const { out, code } = await runHook(env());
    expect(out).toBe("");
    expect(code).toBe(0);
  });

  it("says nothing outside a cork session", async () => {
    // Every claude on this machine may run this hook. Without the key there is
    // no session to speak for, and a stray instruction would steer someone
    // else's compaction toward files that do not exist.
    writeRecord("running");
    const { out } = await runHook({ CORK_DIR: dir });
    expect(out).toBe("");
  });

  it("answers the manual trigger the same as the automatic one", async () => {
    // `/compact` typed by hand goes through the same hook; the run needs its
    // goal preserved either way.
    writeRecord("running");
    const { out } = await runHook(env(), {
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: null,
    });
    expect(out).toContain("PROJECT.md");
  });
});
