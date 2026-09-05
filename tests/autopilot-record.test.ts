import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * AUTOPILOT.json records one thing only: whether cork should be watching this
 * session. Everything about the goal itself is read from claude's transcript,
 * so the two cannot drift — and a daemon restart resumes watching without
 * needing to know how far along the task was.
 */
let dir: string;

async function load() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  return import("../src/session/autopilot.js");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-autopilot-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the record", () => {
  it("reads back what it wrote", async () => {
    const { saveAutopilot, loadAutopilot } = await load();
    saveAutopilot("s1", { state: "running", goal: "ship it", nudgeCount: 2 });
    expect(loadAutopilot("s1")).toMatchObject({
      state: "running",
      goal: "ship it",
      nudgeCount: 2,
    });
  });

  it("calls a session with no record idle, not running", async () => {
    // The safe default: cork must not start pushing a session nobody asked it
    // to watch, least of all after an upgrade that introduced the file.
    const { loadAutopilot, isRunning } = await load();
    expect(loadAutopilot("never-seen").state).toBe("idle");
    expect(isRunning(loadAutopilot("never-seen"))).toBe(false);
  });

  it("treats a corrupt record as idle rather than throwing", async () => {
    const { loadAutopilot, autopilotPath } = await load();
    fs.mkdirSync(path.dirname(autopilotPath("s2")), { recursive: true });
    fs.writeFileSync(autopilotPath("s2"), "{ truncated");
    expect(loadAutopilot("s2").state).toBe("idle");
  });

  it("merges an update instead of replacing the record", async () => {
    const { saveAutopilot, updateAutopilot, loadAutopilot } = await load();
    saveAutopilot("s3", { state: "running", goal: "keep me" });
    updateAutopilot("s3", { nudgeCount: 1 });
    expect(loadAutopilot("s3")).toMatchObject({
      state: "running",
      goal: "keep me",
      nudgeCount: 1,
    });
  });

  it("clears the per-stall counters when a run ends", async () => {
    // A later run must not inherit a stuck-warning or a long backoff from the
    // previous one.
    const { saveAutopilot, stopAutopilot, loadAutopilot } = await load();
    saveAutopilot("s4", {
      state: "running",
      nudgeCount: 3,
      stuckWarned: true,
      restartCount: 2,
    });
    stopAutopilot("s4", "met", "all done");

    const rec = loadAutopilot("s4");
    expect(rec).toMatchObject({
      state: "stopped",
      stopReason: "met",
      stopDetail: "all done",
      nudgeCount: 0,
      stuckWarned: false,
      restartCount: 0,
    });
    expect(rec.stoppedAt).toBeTruthy();
  });

  it("lives inside the session's own directory", async () => {
    const { saveAutopilot, autopilotPath } = await load();
    const { sessionDir } = await import("../src/session/store.js");
    saveAutopilot("s5", { state: "running" });
    expect(path.dirname(autopilotPath("s5"))).toBe(sessionDir("s5"));
  });
});

describe("the goal", () => {
  async function writeGoal(key: string, body: string) {
    const { goalFilePath } = await load();
    fs.mkdirSync(path.dirname(goalFilePath(key)), { recursive: true });
    fs.writeFileSync(goalFilePath(key), body);
  }

  it("is GOAL.md, whole, line breaks and all", async () => {
    // Not a first line with material behind it: the evaluator has no tools and
    // judges from the condition text alone, so anything held back is something
    // the judgement cannot use.
    const { readGoal } = await load();
    await writeGoal("g1", "the condition:\n1. one thing\n2. another\n\n");
    expect(readGoal("g1")).toBe("the condition:\n1. one thing\n2. another");
  });

  it("is null when there is no GOAL.md at all", async () => {
    const { readGoal } = await load();
    expect(readGoal("g2")).toBeNull();
  });

  it("passes a plain condition", async () => {
    const { checkGoal } = await load();
    expect(checkGoal("everything in the checklist is done")).toBeNull();
  });

  it("passes a multi-line one", async () => {
    // Typed line by line with a soft newline between, so nothing folds; a
    // measured 21-line goal set cleanly.
    const { checkGoal } = await load();
    expect(checkGoal("done when:\n- the suite passes\n- it is committed")).toBeNull();
  });

  it("rejects what cannot be used as a goal", async () => {
    const { checkGoal, MAX_GOAL_CHARS } = await load();
    expect(checkGoal(null)).toBe("missing");
    expect(checkGoal("   ")).toBe("empty");
    expect(checkGoal("x".repeat(MAX_GOAL_CHARS + 1))).toBe("too-long");
  });

  it("rejects a single line long enough to be folded into a paste", async () => {
    // Cork types one line at a time, so the per-line budget is what matters:
    // past ~800 characters claude folds that input into a `[Pasted text]`
    // block and the /goal stops being a command at all, silently.
    const { checkGoal, MAX_GOAL_LINE_CHARS } = await load();
    const long = "x".repeat(MAX_GOAL_LINE_CHARS + 1);
    expect(checkGoal(`done when:\n${long}`)).toBe("line-too-long");
    // Same characters, broken up: fine.
    expect(checkGoal(`done when:\n${"x".repeat(400)}\n${"x".repeat(400)}`)).toBeNull();
  });

  it("keeps the line budget clear of the folding boundary", async () => {
    const { MAX_GOAL_LINE_CHARS } = await load();
    expect(MAX_GOAL_LINE_CHARS).toBeLessThanOrEqual(600);
  });

  it("rejects a goal judged against a file the model maintains", async () => {
    // The cheat this exists to stop: a condition like "every item in section 5
    // of PROJECT.md is satisfied" can be passed by rewriting section 5, and the
    // evaluator — which re-reads whatever it was last shown — cannot tell.
    const { checkGoal, projectFilePath } = await load();
    const key = "sess-x";
    expect(
      checkGoal("every item in section 5 of PROJECT.md is satisfied", key)
    ).toBe("self-referential");
    expect(checkGoal(`every item in ${projectFilePath(key)} is done`, key)).toBe(
      "self-referential"
    );
  });

  it("does not reject a goal that mentions GOAL.md", async () => {
    // GOAL.md IS the condition, delivered whole — a mention of it points at
    // text the evaluator already has in front of it.
    const { checkGoal } = await load();
    expect(checkGoal("everything GOAL.md asks for is done", "sess-x")).toBeNull();
  });

  it("still allows a spec the user wrote and the model does not maintain", async () => {
    const { checkGoal } = await load();
    expect(
      checkGoal("every case in /home/me/specs/api-contract.md passes", "sess-x")
    ).toBeNull();
  });

  it("only applies the self-reference check when it knows the session", async () => {
    // checkGoal is also called without a key (a plain shape check).
    const { checkGoal } = await load();
    expect(checkGoal("every item in PROJECT.md is satisfied")).toBeNull();
  });

  it("rejects a goal that is itself a command", async () => {
    // The likely mistake: the model writes the whole command out, and cork's
    // own `/goal ` prefix then makes the condition start with a command name.
    const { checkGoal } = await load();
    expect(checkGoal("/goal everything is done")).toBe("is-command");
  });

  it("measures characters, not bytes", async () => {
    // The folding boundary counts characters, so a CJK goal gets the same
    // allowance as an ASCII one rather than a third of it.
    const { checkGoal, MAX_GOAL_LINE_CHARS } = await load();
    expect(checkGoal("目".repeat(MAX_GOAL_LINE_CHARS))).toBeNull();
    expect(checkGoal("目".repeat(MAX_GOAL_LINE_CHARS + 1))).toBe("line-too-long");
  });
});

