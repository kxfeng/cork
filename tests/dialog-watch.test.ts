import { describe, it, expect, vi } from "vitest";
import { TranscriptWatcher, formatDialog } from "../src/session/transcript-watcher.js";
import { readDialog, type Dialog } from "../src/session/dialog.js";

/**
 * Telling the chat that claude is waiting on a person.
 *
 * A dialog stops the session dead and writes nothing to the transcript, so the
 * only way to know is to look at the screen on a timer. What is tested here is
 * everything around that look: how often, when to stay quiet, and saying each
 * thing once rather than every 30 seconds.
 */
const W = 155;
const rule = (ch: string) => ch.repeat(W);

const PICKER = readDialog(
  [
    rule("▔"),
    "   Select model",
    "",
    "   ❯ 1. Default (recommended)  Opus 5",
    "     2. Fable                  Fable 5.1",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n"),
  W
)!;

const TRUST = readDialog(
  [
    rule("─"),
    " Accessing workspace:",
    "",
    " /var/tmp/probe",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
  ].join("\n"),
  W
)!;

const TYPING = readDialog(
  [
    rule("▔"),
    "   Submit feedback / bug report",
    "",
    "   Describe the issue below:",
    "",
    "   Enter to continue · Esc to cancel",
  ].join("\n"),
  W
)!;

/** A watcher wired to a dialog that the test moves under it. */
function makeWatcher(state: {
  dialog: Dialog | null;
  driving: boolean;
  /** ms, or null when nobody is attached to the pane. */
  activity?: number | null;
}) {
  const said: string[] = [];
  let now = 1_000_000;
  const w = new TranscriptWatcher({
    workspace: "/tmp/nowhere",
    sessionId: "s",
    sessionKey: "k",
    inject: () => true,
    notify: (t) => said.push(t),
    now: () => now,
    dialog: {
      read: () => state.dialog,
      driving: () => state.driving,
      clientActivity: () => state.activity ?? null,
    },
  });
  // The poll is time-based; drive the clock rather than the timer.
  const tick = (advanceMs = 31_000) => {
    now += advanceMs;
    (w as any).tick();
  };
  return { said, tick, at: () => now, w };
}

describe("noticing a dialog", () => {
  it("says so once, not on every tick", () => {
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    tick();
    tick();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Select model");
  });

  it("does not look more often than the poll interval", () => {
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick(31_000);
    state.dialog = TRUST;
    tick(5_000); // too soon: nothing is read
    expect(said).toHaveLength(1);
    tick(31_000);
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("Accessing workspace");
  });

  it("stays quiet while cork is the one working the dialog", () => {
    // /model opens a picker on purpose. Reporting cork's own keystrokes back
    // to the chat as something needing attention is pure noise.
    const state = { dialog: PICKER as Dialog | null, driving: true, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    tick();
    expect(said).toEqual([]);
  });

  it("speaks up again when the dialog changes under it", () => {
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    state.dialog = TRUST;
    tick();
    expect(said).toHaveLength(2);
  });
});

describe("someone at the terminal", () => {
  // Both ways in are ordinary tmux clients — `tmux attach` and the web
  // terminal — so one reading covers both, and `client_activity` says whether
  // the person is still there.

  it("stays quiet about a dialog the person at the terminal just opened", () => {
    // Opening /help in the terminal put three of these in a real chat. The
    // dialog is found within a poll of their keystroke, so the gap is small.
    const state = {
      dialog: PICKER as Dialog | null,
      driving: false,
      activity: 1_030_000 - 5_000, // typed 5s before the check
    };
    const { said, tick } = makeWatcher(state);
    tick(); // now = 1_031_000
    tick();
    expect(said).toEqual([]);
  });

  it("says a dialog that appeared long after the last keystroke", () => {
    // Attached but away: claude put something up on its own, minutes after
    // they stopped typing. Nobody is reading it, so it is said at once.
    const state = {
      dialog: PICKER as Dialog | null,
      driving: false,
      activity: 1_031_000 - 10 * 60_000, // last typed ten minutes ago
    };
    const { said, tick } = makeWatcher(state);
    tick();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Select model");
  });

  it("keeps its peace for as long as they stay attached", () => {
    // The gap is measured once, when the dialog is first seen. A dialog they
    // opened themselves is theirs, and sitting there does not make it news.
    const state = {
      dialog: PICKER as Dialog | null,
      driving: false,
      activity: 1_031_000 - 5_000,
    };
    const { said, tick } = makeWatcher(state);
    for (let i = 0; i < 20; i++) tick();
    expect(said).toEqual([]);
  });

  it("says it at once when nobody is attached", () => {
    // An autopilot run nobody is watching is the case this exists for.
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    expect(said).toHaveLength(1);
  });

  it("says it when the person detaches while the dialog is still up", () => {
    // Suppressing must not mark it told, or detaching would lose it for good.
    const state = {
      dialog: PICKER as Dialog | null,
      driving: false,
      activity: 1_031_000 - 5_000 as number | null,
    };
    const { said, tick } = makeWatcher(state);
    tick();
    expect(said).toEqual([]);
    state.activity = null; // detached
    tick();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Select model");
  });
});

describe("when it goes away", () => {
  it("says so, but only if someone was told to look", () => {
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    state.dialog = null;
    tick();
    expect(said).toHaveLength(2);
    expect(said[1]).toContain("Dialog closed");
    expect(said[1]).toContain("Select model");
  });

  it("says nothing at all when there was never a dialog", () => {
    const state = { dialog: null as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    tick();
    expect(said).toEqual([]);
  });

  it("stays quiet about a dialog cork answered from a command", () => {
    // `/pick` replies with what it did. Without this the next check — finding
    // an empty screen — would follow that reply with "Dialog closed" about the
    // dialog the reply just closed, so the chat sees one action twice.
    const state = { dialog: PICKER as Dialog | null, driving: false, activity: null };
    const { said, tick, w } = makeWatcher(state);
    tick();
    expect(said).toHaveLength(1);
    state.dialog = null;
    w.dialogHandled();
    tick();
    expect(said).toHaveLength(1);
  });

  it("says nothing when cork answered it itself", () => {
    // cork answers the startup dialogs (trust, dev-channel) before the session
    // is connected, and the read returns null until then — so the chat never
    // hears about a question that was already handled.
    const state = { dialog: null as Dialog | null, driving: false, activity: null };
    const { said, tick } = makeWatcher(state);
    tick();
    state.dialog = PICKER;
    state.driving = true;
    tick();
    state.dialog = null;
    state.driving = false;
    tick();
    expect(said).toEqual([]);
  });
});

describe("the message", () => {
  // The dialog goes in a code block, unchanged. That is both the boundary
  // between claude's words and cork's, and what keeps the picker's two
  // columns lined up — they align on spaces, and any re-flow loses them.

  it("names the dialog in the same shape as every other cork notice", () => {
    // `emoji + subject + what happened`, the same as the autopilot messages.
    expect(formatDialog(PICKER).split("\n")[0]).toBe("🔔 Dialog waiting for an answer");
    expect(formatDialog(TYPING).split("\n")[0]).toBe("🔔 Dialog needs you at the terminal");
  });

  it("shows the screen verbatim, inside a fence", () => {
    const text = formatDialog(PICKER);
    expect(text).toContain("```");
    expect(text).toContain("❯ 1. Default (recommended)  Opus 5");
    expect(text).toContain("  2. Fable                  Fable 5.1");
    // claude's own cursor, not a label of cork's.
    expect(text).not.toContain("selected");
  });

  it("keeps the dialog's own numbering rather than adding a second one", () => {
    const text = formatDialog(PICKER);
    expect(text).not.toContain("**1.**");
    expect(text).toContain("1. Default");
  });

  it("ends with one line of instructions, whatever the dialog is", () => {
    expect(formatDialog(PICKER).trimEnd().split("\n").pop()).toBe(
      "`/pick <n>` to choose · `/pick esc` to cancel"
    );
    expect(formatDialog(TYPING).trimEnd().split("\n").pop()).toBe(
      "`/pick esc` to cancel · or answer it in the terminal"
    );
  });

  it("says nothing about keys that cannot be pressed from a chat", () => {
    // claude's own footer is about Enter, `s` and Tab at the terminal — which
    // is where the reader of this message is not.
    const text = formatDialog(PICKER);
    expect(text).not.toContain("Enter to set as default");
    expect(text).not.toContain("s to use this session only");
  });

  it("says the same word for the same key every time", () => {
    // Esc does one thing — close the dialog — and calling it "cancel" here and
    // "dismiss" there was cork inventing a distinction that does not exist.
    for (const d of [PICKER, TRUST, TYPING]) {
      expect(formatDialog(d)).toContain("`/pick esc` to cancel");
    }
  });

  it("sends people to the terminal when the list runs off the screen", () => {
    const folded = readDialog(
      [
        rule("▔"),
        "   Permissions  Allow   Ask   Deny",
        "",
        "   ❯ 1.  Add a new rule…",
        "     2.  Bash(echo:*)",
        "   ↓ 3.  Bash(git push:*)",
        "",
        "   Esc to cancel",
      ].join("\n"),
      W
    )!;
    expect(folded.folded).toBe(true);
    expect(folded.answerable).toBe(false);
    expect(formatDialog(folded).trimEnd().split("\n").pop()).toBe(
      "`/pick esc` to cancel · or answer it in the terminal"
    );
  });

  it("trims long prose but never an option", () => {
    // A list cut short would still be numbered by /pick, and someone could
    // choose an option they were never shown.
    const many = [rule("▔"), "   Title"];
    for (let i = 0; i < 20; i++) many.push(`   prose line ${i}`);
    many.push("   ❯ 1. First", "     2. Second", "", "   Esc to cancel");
    const d = readDialog(many.join("\n"), W)!;
    const text = formatDialog(d);
    expect(text).toContain("…");
    expect(text).not.toContain("prose line 19");
    expect(text).toContain("1. First");
    expect(text).toContain("2. Second");
  });
});
