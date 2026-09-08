import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The walk cork does to change a session's model: open the picker, step the
 * cursor, confirm it arrived, press `s`, then answer the cost confirmation if
 * one is raised.
 *
 * Driven against a scripted terminal rather than a real one — the point under
 * test is the sequence of keys and the decisions between them, and a real pane
 * can only ever show one of the several endings this has to handle.
 */

/** A stand-in for the pane: renders a picker, moves on arrows, answers keys. */
class FakePane {
  keys: string[] = [];
  phase: "picker" | "confirm" | "idle" = "idle";
  cursor = 0;
  notice: string | null = null;
  model = "Opus 5";
  /** Rows, in the order claude draws them. */
  rows = [
    ["Default (recommended)", "Opus 5 with 1M context · Best for everyday"],
    ["Opus (1M context)", "Opus 5 with 1M context · Best for everyday"],
    ["Fable", "Fable 5.1 · Most capable for your hardest tasks"],
    ["Sonnet", "Sonnet 5 · Efficient for routine tasks"],
    ["Haiku", "Haiku 4.5 · Fastest for quick answers"],
  ];
  currentRow = 1;
  /** Whether pressing `s` raises the "Switch model?" cost confirmation. */
  raisesConfirm = false;
  /** Set to render something cork has no business answering. */
  strangeDialog = false;
  /** Make the arrow keys not take, to prove the read-back is load-bearing. */
  ignoreArrows = false;
  /** Close the picker on `s` without switching and without saying anything. */
  swallowsS = false;

  open(): void {
    this.phase = "picker";
    this.cursor = this.currentRow;
  }

  send(args: string): void {
    this.keys.push(args);
    const arrows = /^-N (\d+) (Down|Up)$/.exec(args);
    if (arrows && this.phase === "picker") {
      if (this.ignoreArrows) return;
      const step = Number(arrows[1]) * (arrows[2] === "Down" ? 1 : -1);
      this.cursor = Math.max(0, Math.min(this.rows.length - 1, this.cursor + step));
      return;
    }
    if (args === "Escape") {
      this.phase = "idle";
      return;
    }
    if (args === "s" && this.phase === "picker") {
      if (this.swallowsS) {
        this.phase = "idle";
        return;
      }
      if (this.strangeDialog) {
        this.phase = "idle";
        return;
      }
      if (this.raisesConfirm) {
        this.phase = "confirm";
        return;
      }
      this.apply();
      return;
    }
    if (args === "Enter" && this.phase === "confirm") {
      // Answered by walking the cursor and pressing Enter, never by typing the
      // option's number: not every dialog claude draws numbers its options.
      this.apply();
    }
  }

  private apply(): void {
    this.model = this.rows[this.cursor][1].split("·")[0].trim().replace(" with 1M context", "");
    // claude's own line under the command, which is what a switch is read
    // from. Its name is claude's, not the status line's: the long-context row
    // reads "Opus 5 (1M context)" here and "Opus 5" down there.
    this.notice = `  \u23BF  Set model to ${this.model} for this session only`;
    this.currentRow = this.cursor;
    this.phase = "idle";
  }

  render(): string {
    // The frames are drawn the way claude draws them, because that is what the
    // reader keys on: a rule exactly as wide as the pane, options indented,
    // and the prompt marker at column 0 only when the input box is there.
    const over = "▔".repeat(WIDTH);
    const under = "─".repeat(WIDTH);
    if (this.phase === "picker") {
      const body = this.rows
        .map(([label, desc], i) => {
          const mark = i === this.cursor ? " ❯" : "  ";
          const tick = i === this.currentRow ? " ✔" : "";
          return `  ${mark} ${i + 1}. ${label}${tick}   ${desc}`;
        })
        .join("\n");
      return `${over}\n   Select model\n\n${body}\n\n   Enter to set as default · s to use this session only · Esc to cancel`;
    }
    if (this.phase === "confirm") {
      return `${over}\n   Switch model?\n\n   This conversation is cached for the current model.\n\n   ❯ 1. Yes, switch\n     2. No, go back`;
    }
    if (this.strangeDialog) {
      return `${over}\n   Do you trust the files in this folder?\n\n   ❯ 1. Yes, proceed\n     2. No, exit`;
    }
    const said = this.notice ? `${this.notice}\n` : "";
    return `${said}${under}\n❯ \n${under}\n  ${this.model} | Context: ▒▒▒ 24K/1M 2%`;
  }
}

const WIDTH = 155;

const { pane } = vi.hoisted(() => ({ pane: { current: null as any } }));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    const p = pane.current as FakePane;
    if (cmd.includes("display-message")) return String(WIDTH);
    if (cmd.includes("capture-pane")) return p.render();
    const m = /send-keys -t "[^"]*" (.+)$/.exec(cmd);
    if (m) p.send(m[1]);
    return "";
  },
}));

const WS = "/tmp/cork-model-ws";
let dir: string;
let fake: FakePane;

async function makeManager() {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  // The typing half is covered by its own tests; here the picker is what
  // matters, so the command is taken as sent and the picker as opened.
  mgr.sendSlashCommand = async () => {
    fake.open();
    return { ok: true };
  };
  return mgr;
}

const FAST = { drawMs: 500, settleMs: 2000, pollMs: 1 };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-model-"));
  process.env.CORK_DIR = dir;
  fake = new FakePane();
  pane.current = fake;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("switching a session's model", () => {
  it("walks to the row and presses s, not Enter", async () => {
    const mgr = await makeManager();
    const r = await mgr.switchModel("k", "fable", FAST);
    expect(r).toMatchObject({ ok: true, model: "Fable 5.1" });
    // Enter would have written the machine-wide default.
    expect(fake.keys).toEqual(["-N 1 Down", "s"]);
  });

  it("steps upward when the row is above the cursor", async () => {
    const mgr = await makeManager();
    fake.currentRow = 4; // sitting on Haiku
    const r = await mgr.switchModel("k", "opus (1m context)", FAST);
    expect(r.ok).toBe(true);
    expect(fake.keys).toContain("-N 3 Up");
  });

  it("answers the cost confirmation when it is raised", async () => {
    const mgr = await makeManager();
    fake.raisesConfirm = true;
    const r = await mgr.switchModel("k", "sonnet", FAST);
    expect(r).toMatchObject({ ok: true, model: "Sonnet 5" });
    expect(fake.keys).toEqual(["-N 2 Down", "s", "Enter"]);
  });

  it("does not wait for a confirmation that is not raised", async () => {
    // claude suppresses it once the cost has been acknowledged, so treating it
    // as mandatory would hang every switch after the first.
    const mgr = await makeManager();
    const r = await mgr.switchModel("k", "haiku", FAST);
    expect(r.ok).toBe(true);
    expect(fake.keys.filter((k) => k === "Enter")).toHaveLength(0);
  });

  it("changes nothing when the session is already on that model", async () => {
    const mgr = await makeManager();
    const r = await mgr.switchModel("k", "opus (1m context)", FAST);
    expect(r).toMatchObject({ ok: true, already: true });
    // Escape, not `s`: a no-op switch still invalidates the prompt cache.
    expect(fake.keys).toEqual(["Escape"]);
  });

  it("does not read an older switch's line as this one's result", async () => {
    // The pane carries scrollback. A "Set model to Fable 5.1" left over from
    // an earlier switch is not evidence about this one, so it is compared
    // against what was on screen before cork typed anything.
    const mgr = await makeManager();
    fake.notice = "  \u23BF  Set model to Fable 5.1 for this session only";
    fake.swallowsS = true;
    const r = await mgr.switchModel("k", "sonnet", FAST);
    expect(r.model).not.toBe("Fable 5.1");
  });

  it("falls back to the name that was asked for when claude says nothing", async () => {
    // The picker is gone and no result line can be read: claude's wording
    // moved. The switch happened; only cork's name for it is missing, and
    // refusing then would report a failure that did not occur.
    const mgr = await makeManager();
    fake.swallowsS = true;
    const r = await mgr.switchModel("k", "sonnet", FAST);
    expect(r).toMatchObject({ ok: true, model: "sonnet" });
  });

  it("refuses an unknown name and reports what was on screen", async () => {
    const mgr = await makeManager();
    const r = await mgr.switchModel("k", "gpt", FAST);
    expect(r.ok).toBe(false);
    expect(r.options).toContain("Fable (Fable 5.1)");
    expect(fake.keys).toEqual(["Escape"]);
  });

  it("aborts rather than press s on a cursor that did not move", async () => {
    const mgr = await makeManager();
    fake.ignoreArrows = true;
    const r = await mgr.switchModel("k", "haiku", FAST);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not put the cursor on Haiku/);
    expect(fake.keys).not.toContain("s");
    expect(fake.keys.at(-1)).toBe("Escape");
  });

  it("hands an unrecognised dialog back instead of pressing keys into it", async () => {
    const mgr = await makeManager();
    fake.strangeDialog = true;
    const r = await mgr.switchModel("k", "fable", FAST);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/does not recognise/);
    expect(r.screen).toMatch(/Do you trust the files/);
    expect(fake.keys.filter((k) => /^\d$/.test(k))).toHaveLength(0);
  });

  it("gives up when the picker never draws", async () => {
    const mgr = await makeManager();
    mgr.sendSlashCommand = async () => ({ ok: true }); // never opens
    const r = await mgr.switchModel("k", "fable", FAST);
    expect(r).toMatchObject({ ok: false, reason: "the model picker did not open" });
  });
});
