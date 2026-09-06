import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Typing a slash command into a pane.
 *
 * This gets the text in and submits it; whether claude took it as a COMMAND is
 * settled later, by the watcher reading the transcript. What is checked here is
 * the part that can only be checked before submitting: that the command is at
 * the FRONT of the input line, because a `/goal` that is not is sent as an
 * ordinary chat message with nothing anywhere reporting it.
 */
const WS = "/tmp/cork-slash-ws";

const { execCalls, tmuxSessions, transcript, pane } = vi.hoisted(() => ({
  execCalls: [] as string[],
  tmuxSessions: { value: "" },
  // The tail is read once before typing and again after, so the two have to be
  // told apart: "did this command appear" is a comparison, not a lookup.
  transcript: { reads: 0, before: [] as unknown[], after: [] as unknown[] },
  // A pane that behaves like one: it shows what was typed into it, and C-u
  // clears it. Cork reads it back to check the command landed at the prompt.
  pane: { typed: "", swallowTyping: false, renderDelayMs: 0, typedAt: 0 },
}));

vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    const s = String(cmd);
    execCalls.push(s);
    if (s.includes("list-sessions")) return tmuxSessions.value;
    if (s.includes("capture-pane")) {
      // A slow TUI shows nothing for a while after the keys land.
      const visible =
        pane.renderDelayMs && Date.now() - pane.typedAt < pane.renderDelayMs
          ? ""
          : pane.typed;
      const [first, ...rest] = visible.split("\n");
      return [
        "● earlier output",
        "❯ Goal set: an older goal",
        "─────",
        `❯ ${first}`,
        ...rest.map((l) => `  ${l}`), // continuation rows carry no marker
        "─────",
        "  Opus 5",
      ].join("\n");
    }
    // A soft newline: the TUI keeps the draft and moves to a new line.
    if (/send-keys .* M-Enter$/.test(s)) {
      pane.typed += "\n";
      pane.typedAt = Date.now();
    }
    // Backspace takes what is before the cursor, Delete what is after; the
    // pair empties the box however the cursor was left.
    if (/send-keys .* -N \d+ (BSpace|DC)$/.test(s)) pane.typed = "";
    const typed = /-l -- '([\s\S]*)'\s*$/.exec(s);
    if (typed && !pane.swallowTyping) {
      pane.typed += typed[1].replace(/'\\''/g, "'");
      pane.typedAt = Date.now();
    }
    return "";
  },
}));

vi.mock("../src/session/transcript.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readTranscriptTail: () =>
    transcript.reads++ === 0 ? transcript.before : transcript.after,
}));

/**
 * A command that starts a turn — which `/goal <condition>` does — is recorded as
 * a `user` row, not a `system` one. Using the wrong shape here is what let a
 * broken confirmation pass its unit tests while failing every real run.
 */
const localCommandRow = (name: string, args: string) => ({
  type: "user",
  message: {
    role: "user",
    content: `<command-name>/${name}</command-name>\n            <command-args>${args}</command-args>`,
  },
});

let dir: string;

async function makeManager() {
  vi.resetModules();
  const { SessionManager } = await import("../src/session/manager.js");
  const mgr = new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [] },
    channels: {},
  } as never) as any;
  const { saveSession } = await import("../src/session/store.js");
  saveSession("sess-1", {
    sessionId: "claude-sess",
    channel: "lark",
    chatId: "oc_x",
    chatType: "group",
    chatName: "x",
    workspace: WS,
    createdAt: "",
    lastActiveAt: "",
    lastMessagePreview: "",
    claudeSessionStarted: true,
    mentionRequired: false,
  });
  return mgr;
}

/** Keys typed into the pane, in order, as tmux received them. */
const sentKeys = () =>
  execCalls.filter((c) => c.includes("send-keys")).map((c) => c);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-slash-"));
  process.env.CORK_DIR = dir;
  execCalls.length = 0;
  tmuxSessions.value = "cork_sess-1";
  transcript.reads = 0;
  transcript.before = [];
  transcript.after = [];
  pane.typed = "";
  pane.swallowTyping = false;
  pane.renderDelayMs = 0;
  pane.typedAt = 0;
});

afterEach(() => {
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sendSlashCommand", () => {
  it("clears the input, types the command, then submits", async () => {
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "do the thing")];

    const r = await mgr.sendSlashCommand("sess-1", "/goal do the thing");

    expect(r.ok).toBe(true);
    const keys = sentKeys();
    // No Escape on the first attempt. Measured with editorMode "vim" while the
    // model was streaming: Escape from INSERT only switches mode, but Escape
    // from NORMAL interrupts the model — and a pane sits in NORMAL after any
    // earlier interrupt. `i` reaches a typable state from either mode without
    // that risk; in INSERT it is just a character, which the sweep removes.
    expect(keys.some((k) => k.includes("Escape"))).toBe(false);
    expect(keys[0]).toMatch(/send-keys .* i$/);
    expect(keys[1]).toMatch(/-N \d+ BSpace$/);
    expect(keys[2]).toMatch(/-N \d+ DC$/);
    expect(keys.find((k) => k.includes("/goal do the thing"))).toBeTruthy();
    expect(keys[keys.length - 1]).toContain("Enter");
  });

  it("passes the command as one literal argument, after --", async () => {
    // Without `--`, a command starting with `-` is read as a tmux flag.
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "x")];

    await mgr.sendSlashCommand("sess-1", "/goal x");

    const typed = sentKeys().find((k) => k.includes("/goal"))!;
    expect(typed).toContain(" -l -- ");
  });

  it("quotes a goal containing a single quote instead of breaking the shell", async () => {
    // The goal text comes from GOAL.md, which the model wrote. It reaches a
    // shell command line, so quoting is not cosmetic.
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "y")];

    await mgr.sendSlashCommand("sess-1", "/goal it's done; rm -rf /");

    const typed = sentKeys().find((k) => k.includes("/goal"))!;
    // The standard '\'' dance: close, escaped quote, reopen — so the whole
    // thing stays inside one single-quoted word.
    expect(typed).toContain(`'/goal it'\\''s done; rm -rf /'`);
  });

  it("types a multi-line goal line by line, with soft newlines between", async () => {
    // Claude folds ANY single input that is long or pasted as several lines
    // into a `[Pasted text]` block, and a `/goal` inside one is not a command
    // at all — it is sent as an ordinary message, silently. Typed this way
    // each line is its own short input, and the newlines still reach the
    // condition: a 21-line goal was measured setting cleanly.
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "done when:\n- a\n- b")];

    const r = await mgr.sendSlashCommand("sess-1", "/goal done when:\n- a\n- b");

    expect(r.ok).toBe(true);
    const keys = sentKeys();
    const typed = keys.filter((k) => k.includes(" -l -- "));
    expect(typed).toHaveLength(3);
    expect(typed[0]).toContain("/goal done when:");
    expect(typed[1]).toContain("- a");
    expect(typed[2]).toContain("- b");
    // Two soft newlines between three lines, and exactly one submit.
    expect(keys.filter((k) => /M-Enter$/.test(k))).toHaveLength(2);
    expect(keys.filter((k) => /send-keys [^|]* Enter$/.test(k))).toHaveLength(1);
    // The first line is checked before the rest follows it: once the draft is
    // taller than the pane, the TUI shows only its tail and there is nothing
    // left to check against.
    const secondLineAt = execCalls.findIndex((c) => c === typed[1]);
    expect(
      execCalls.slice(0, secondLineAt).some((c) => c.includes("capture-pane"))
    ).toBe(true);
  });

  it("starts the session when its pane is not running, then types", async () => {
    // A session nobody has spoken to since the daemon started has no claude
    // process behind it. An ordinary message would start one on its way
    // through; a slash command is typed into the pane, so it has to do the
    // same rather than report the session as unusable.
    const mgr = await makeManager();
    tmuxSessions.value = ""; // nothing running yet
    transcript.after = [localCommandRow("goal", "do the thing")];
    const started: string[] = [];
    // The state machine needs a daemon, a real pane and an MCP registration to
    // reach "connected"; the seam here is the readiness wait itself.
    (mgr as any).ensureConnected = async (key: string) => {
      started.push(key);
      tmuxSessions.value = "cork_sess-1";
      return true;
    };

    const r = await mgr.sendSlashCommand("sess-1", "/goal do the thing");

    expect(started).toEqual(["sess-1"]);
    expect(r.ok).toBe(true);
    expect(sentKeys().some((k) => k.includes("/goal do the thing"))).toBe(true);
  });

  it("says so when the session could not be started, and types nothing", async () => {
    const mgr = await makeManager();
    tmuxSessions.value = "";
    (mgr as any).ensureConnected = async () => false;

    const r = await mgr.sendSlashCommand("sess-1", "/goal x");

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("could not be started");
    expect(sentKeys()).toHaveLength(0);
  });

  it("gives up rather than submitting a command that is not at the prompt", async () => {
    // If the typing never lands at the front of the input line, submitting it
    // would send a chat message that reads like a command and sets nothing.
    const mgr = await makeManager();
    pane.swallowTyping = true; // nothing cork types ever appears

    const r = await mgr.sendSlashCommand("sess-1", "/goal do the thing", {
      confirmMs: 1500,
      settleMs: 700, // the real wait is seconds; the behaviour is the same
    });

    expect(r.ok).toBe(false);
    expect(r.reason).toContain("input box");
    // Never submitted.
    expect(sentKeys().some((k) => k.includes("Enter"))).toBe(false);
  });

  it("brings Escape out only once typing alone has failed", async () => {
    // Escape can interrupt the model (from NORMAL it does), so the first
    // attempt never sends one. It is still the only way out of the history
    // filter panel, which `i` cannot leave — so a retry does send it.
    const mgr = await makeManager();
    pane.swallowTyping = true; // force every attempt to fail the check

    await mgr.sendSlashCommand("sess-1", "/goal do the thing", {
      confirmMs: 1500,
      settleMs: 700,
    });

    const keys = sentKeys();
    const escapes = keys.filter((k) => k.includes("Escape"));
    const firstI = keys.findIndex((k) => /send-keys .* i$/.test(k));
    // One per retry, never on the first attempt.
    expect(escapes).toHaveLength(2);
    expect(keys.indexOf(escapes[0])).toBeGreaterThan(firstI);
  });

  it("waits for a slow pane to render instead of retyping over it", async () => {
    // What a 21-line goal actually did: the TUI had not laid it out half a
    // second after the last key, so the check failed, the next attempt typed
    // its command after the first one's text, and the box ended up holding the
    // goal twice. Polling is what stops that.
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "do the thing")];
    pane.renderDelayMs = 1200; // slower than one settle interval

    const r = await mgr.sendSlashCommand("sess-1", "/goal do the thing");

    expect(r.ok).toBe(true);
    // One pass of typing, not three.
    expect(sentKeys().filter((k) => k.includes("/goal do the thing"))).toHaveLength(1);
  });

  it("clears a multi-line draft, whichever side of the cursor it is on", async () => {
    // Backspace alone stops at the cursor: a real run left three characters
    // behind that way, and the next attempt typed around them.
    const mgr = await makeManager();
    transcript.after = [localCommandRow("goal", "x")];
    pane.typed = "leftover line one\nleftover line two\nleftover line three";

    const r = await mgr.sendSlashCommand("sess-1", "/goal a\nb");

    expect(r.ok).toBe(true);
    expect(pane.typed).toBe("/goal a\nb");
  });

  it("refuses a session it has no record of", async () => {
    const mgr = await makeManager();
    const r = await mgr.sendSlashCommand("no-such-session", "/goal x");
    expect(r.ok).toBe(false);
    expect(sentKeys()).toHaveLength(0);
  });
});
