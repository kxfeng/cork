import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Filing a finished run when a new goal is drafted over it.
 *
 * The point is what the next run can read: the goal as it was set, how it
 * went, and the working document as it stood at the end. The point is NOT
 * bookkeeping — every failure here has to end with the session ready to draft
 * a new goal anyway, because that is what the user asked for.
 */
const KEY = "sess-archive";
let dir: string;

async function load() {
  vi.resetModules(); // paths.ts and time.ts read config at import time
  return import("../src/session/autopilot.js");
}

const write = (name: string, body: string) =>
  fs.writeFileSync(path.join(dir, "sessions", KEY, name), body);

const read = (rel: string) =>
  fs.readFileSync(path.join(dir, "sessions", KEY, "archive", rel), "utf-8");

const ls = () => {
  try {
    return fs.readdirSync(path.join(dir, "sessions", KEY, "archive")).sort();
  } catch {
    return [];
  }
};

const exists = (name: string) =>
  fs.existsSync(path.join(dir, "sessions", KEY, name));

/** A run that ended, as the record holds it. */
const ENDED = {
  state: "stopped",
  goal: "ship it",
  startedAt: "2026-09-05T17:45:25.355Z",
  stoppedAt: "2026-09-05T18:49:03.166Z",
  stopReason: "met",
  stopDetail: "GOAL 九条逐条验证通过。证据来自对话的关键节点：181 个 trace_id，重复 0 个。",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-archive-"));
  process.env.CORK_DIR = dir;
  fs.mkdirSync(path.join(dir, "sessions", KEY), { recursive: true });
  // Pinned so the folder name means the same thing on any machine.
  fs.writeFileSync(
    path.join(dir, "config.jsonc"),
    JSON.stringify({ timezone: "Asia/Singapore" })
  );
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("archiveRun", () => {
  it("files the run under the UTC time it started", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);
    write("GOAL.md", "ship it\n");
    write("PROJECT.md", "did some of it\n");

    // The same instant the record holds as `2026-09-05T17:45:25.355Z`.
    expect(archiveRun(KEY)).toBe("20260905-174525");
    expect(ls()).toEqual(["20260905-174525"]);
  });

  it("ignores the display zone entirely", async () => {
    // The config here says Asia/Singapore, where this instant is 01:45 the
    // NEXT day. Rendering the archive in it once put the folder name and the
    // record's own `startedAt` eight hours and a calendar day apart, and
    // telling them apart meant reading cork's source. The reader of an archive
    // is a model, and a model has no local zone.
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);
    write("GOAL.md", "ship it\n");

    const name = archiveRun(KEY) as string;
    expect(name).toBe("20260905-174525");
    expect(read(`${name}/GOAL.md`)).toContain("- Started: 2026-09-05 17:45 (UTC)");
  });

  it("writes the goal first, then how it went, then the verdict", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);
    write("GOAL.md", "ship it\n");

    const body = read(`${archiveRun(KEY)}/GOAL.md`);

    // A model opening this sees `# Goal` first and would otherwise read it as
    // the current one.
    expect(body.startsWith("> An archived run.")).toBe(true);
    expect(body.indexOf("# Goal")).toBeLessThan(body.indexOf("# Outcome"));
    expect(body.indexOf("# Outcome")).toBeLessThan(body.indexOf("## Verdict"));
    expect(body).toContain("- Result: completed — the goal was met");
    expect(body).toContain("- Started: 2026-09-05 17:45 (UTC)");
    expect(body).toContain("ran 1h3min");
    // The note above the verdict does as much work as the verdict: "all nine
    // conditions verified" is one line from being read as nine requirements.
    expect(body).toContain("not a requirement for anything that follows");
    expect(body).toContain("181 个 trace_id");
  });

  it("moves the files rather than copying them", async () => {
    // A stale GOAL.md left in place is one a model edits instead of replacing,
    // and two goals in a session directory is one too many.
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);
    write("GOAL.md", "ship it\n");
    write("PROJECT.md", "did some of it\n");

    const name = archiveRun(KEY);

    expect(exists("GOAL.md")).toBe(false);
    expect(exists("PROJECT.md")).toBe(false);
    expect(read(`${name}/PROJECT.md`)).toBe("did some of it\n");
  });

  it("keeps the verdict whole up to the cap, and says when it cut", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, { ...ENDED, stopDetail: "x".repeat(9000) } as never);
    write("GOAL.md", "ship it\n");

    const body = read(`${archiveRun(KEY)}/GOAL.md`);
    expect(body).toContain("x".repeat(8000));
    expect(body).not.toContain("x".repeat(8001));
    expect(body).toContain("cut at 8000 characters");
  });

  it("leaves out the verdict section when there is no verdict", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, { ...ENDED, stopDetail: undefined } as never);
    write("GOAL.md", "ship it\n");

    expect(read(`${archiveRun(KEY)}/GOAL.md`)).not.toContain("## Verdict");
  });

  it("says in words how the run ended, not in cork's enum", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, { ...ENDED, stopReason: "unreachable" } as never);
    write("GOAL.md", "ship it\n");

    const body = read(`${archiveRun(KEY)}/GOAL.md`);
    expect(body).toContain("the session could not be brought back");
    expect(body).not.toContain("Result: unreachable");
  });

  it("archives nothing for a run that has not ended", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, { state: "running", goal: "ship it" } as never);
    write("GOAL.md", "ship it\n");

    expect(archiveRun(KEY)).toBeNull();
    expect(exists("GOAL.md")).toBe(true); // a live run keeps its goal
    expect(ls()).toEqual([]);
  });

  it("archives nothing when the run never wrote anything", async () => {
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);

    expect(archiveRun(KEY)).toBeNull();
    expect(ls()).toEqual([]);
  });

  it("drops the old files when a folder for that second already exists", async () => {
    // Two runs starting in the same second. Merging them would produce a
    // folder that is neither, and the point of this call is to clear the way
    // for a new goal — so the older files go.
    const { archiveRun, saveAutopilot } = await load();
    saveAutopilot(KEY, ENDED as never);
    fs.mkdirSync(path.join(dir, "sessions", KEY, "archive", "20260905-174525"), {
      recursive: true,
    });
    write("GOAL.md", "ship it\n");
    write("PROJECT.md", "did some of it\n");

    expect(archiveRun(KEY)).toBeNull();
    expect(exists("GOAL.md")).toBe(false);
    expect(exists("PROJECT.md")).toBe(false);
  });

  it("keeps every run, so a session can be read back in order", async () => {
    const { archiveRun, saveAutopilot } = await load();

    for (const [started, stopped] of [
      ["2026-09-05T17:45:25.355Z", "2026-09-05T18:49:03.166Z"],
      ["2026-09-06T06:29:07.963Z", "2026-09-06T13:03:24.000Z"],
    ]) {
      saveAutopilot(KEY, { ...ENDED, startedAt: started, stoppedAt: stopped } as never);
      write("GOAL.md", `goal for ${started}\n`);
      archiveRun(KEY);
    }

    expect(ls()).toEqual(["20260905-174525", "20260906-062907"]);
  });
});
