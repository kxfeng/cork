import { describe, it, expect } from "vitest";
import { readDialog, dialogSignature } from "../src/session/dialog.js";

/**
 * The fixtures are pane text captured off real sessions at 155 columns, not
 * written by hand. What the reader keys on — the rule being exactly as wide as
 * the pane, the column an option's text starts at, the prompt marker sitting
 * at column 0 — are all things a hand-written sample would get wrong in a way
 * that made the test pass and the code fail.
 */
const W = 155;
const rule = (ch: string) => ch.repeat(W);

const IDLE = [
  "  ▝▝ ▝▝    /tmp/ws",
  "",
  "❯ /model",
  "  ⎿  Kept model as Opus 5 (1M context) (default)",
  "",
  rule("─"),
  '❯ Try "fix typecheck errors"',
  rule("─"),
  "  Opus 5 (1M context) | Context: ▒▒▒▒ 0/1M 0%",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

const STREAMING = [
  "❯ count from 1 to 60 slowly",
  "",
  "● 1",
  "  2",
  "",
  rule("─"),
  "❯ ",
  rule("─"),
  "  Opus 5 (1M context) | Context: ▒▒▒▒ 24K/1M 2%",
  "  ⏸ manual mode on · ← for agents",
].join("\n");

const PICKER = [
  "❯ /model",
  "",
  rule("▔"),
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "",
  "   ❯ 1. Default (recommended) ✔  Opus 5 with 1M context · Best for everyday, complex tasks",
  "     2. Opus (1M context)        Opus 5 with 1M context · Best for everyday, complex tasks",
  "     3. Fable                    Fable 5.1 · Most capable for your hardest tasks",
  "     4. Sonnet                   Sonnet 5 · Efficient for routine tasks",
  "     5. Haiku                    Haiku 4.5 · Fastest for quick answers",
  "",
  "   ● High effort (default) ←/→ to adjust",
  "",
  "   Use /fast to turn on Fast mode (Opus 5).",
  "",
  "   Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

const CONFIRM = [
  rule("▔"),
  "   Switch model?",
  "   Your next response will be slower and use more tokens",
  "",
  "   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read.",
  "",
  "   ❯ 1. Yes, switch to Sonnet 5",
  "     2. No, go back",
].join("\n");

const PERMISSION = [
  "❯ run bash: curl -s https://example.net -o /tmp/zz3.html",
  "",
  "● I'll run that command.",
  "",
  rule("─"),
  " Bash command",
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  "",
  "   curl -s https://example.net -o /tmp/zz3.html",
  "   Download example.net to /tmp/zz3.html",
  "",
  " This command requires approval",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for: curl *",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

const TRUST = [
  rule("─"),
  " Accessing workspace:",
  "",
  " /var/tmp/probe",
  "",
  " Quick safety check: Is this a project you created or one you trust?",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
].join("\n");

const FEEDBACK_LIST = [
  rule("▔"),
  "   Feedback drafts",
  "",
  "   ❯ + Write new feedback",
].join("\n");

const FEEDBACK_INPUT = [
  rule("▔"),
  "   Submit feedback / bug report",
  "",
  "   Describe the issue below:",
  "",
  "   ╭" + "─".repeat(147) + "╮",
  "   │ Describe the issue…" + " ".repeat(127) + "│",
  "   ╰" + "─".repeat(147) + "╯",
  "",
  "   Enter to continue · Esc to cancel",
].join("\n");

describe("no dialog", () => {
  it("reads an idle pane as taking input", () => {
    expect(readDialog(IDLE, W)).toBeNull();
  });

  it("reads a streaming pane as taking input", () => {
    // The most dangerous false positive: a session that is merely busy would
    // be reported to the user as waiting on them, every 30 seconds.
    expect(readDialog(STREAMING, W)).toBeNull();
  });

  it("is not fooled by a rule the model printed into the conversation", () => {
    // Message text is indented, so it cannot reach the pane's edge — 155 of
    // them wrap to 153 + 2. Neither line is the pane's width.
    const pane = IDLE.replace("● 1", "● " + "▔".repeat(W - 2) + "\n  ▔▔");
    expect(readDialog(pane, W)).toBeNull();
  });

  it("is not fooled by a draft taller than the pane", () => {
    // cork types autopilot goals that are taller than the pane. The rule ABOVE
    // the box scrolls off; the one below it is anchored to the bottom and is
    // always there, so it is still the last rule and the status area is still
    // what follows.
    const tall = [
      "❯ line one of a long goal",
      "  line two",
      "  line three",
      rule("─"),
      "  Opus 5 | Context: ▒▒▒▒ 0/1M 0%",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(readDialog(tall, W)).toBeNull();
  });

  it("is not fooled by the rule above the input box carrying the session title", () => {
    // Captured off a real 200-wide pane. Claude puts the session's title in
    // the rule above the input box, so that line is not one repeated
    // character — 178 of 200. An earlier version needed to recognise it, did
    // not, and reported the status area to a real chat as a dialog. Reading
    // only the LAST rule means that line is never consulted.
    const w = 200;
    const titled =
      "─".repeat(177) + " Cork · Long Task Dev " + "─".repeat(w - 177 - 22);
    expect(titled).toHaveLength(w);
    const pane = [
      "  ⎿  Tip: Use /btw to ask a quick side question",
      "",
      titled,
      "❯ ",
      "─".repeat(w),
      "  Opus 5 | Context: ███████████▒▒▒▒╎▒▒▒▒ 587K/1M 59%",
      "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(readDialog(pane, w)).toBeNull();
  });

  it("reads the status area as what it is, not as a dialog", () => {
    // What follows the last rule on an idle pane offers nothing to choose and
    // no way out, because it is not asking anything. Captured from /context,
    // which prints inline rather than opening an overlay.
    const pane = [
      "❯ /context",
      "  ⎿  (context table printed inline)",
      rule("─"),
      "❯ ",
      rule("─"),
      "  Opus 5 (1M context) | Context: ▒▒▒▒ 0/1M 0%",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
    ].join("\n");
    expect(readDialog(pane, W)).toBeNull();
  });

  it("ignores a rule that is not the pane's full width", () => {
    const narrow = ["●", "─".repeat(W - 1), "   Select model", "   ❯ 1. Yes"].join("\n");
    expect(readDialog(narrow, W)).toBeNull();
  });
});

describe("numbered dialogs", () => {
  it("reads the model picker", () => {
    const d = readDialog(PICKER, W)!;
    expect(d.kind).toBe("overlay");
    expect(d.title).toBe("Select model");
    expect(d.options).toHaveLength(5);
    expect(d.selected).toBe(0);
    expect(d.options[2].text).toContain("3. Fable");
    expect(d.answerable).toBe(true);
    expect(d.footer).toContain("Esc to cancel");
  });

  it("reads the switch-model confirmation", () => {
    const d = readDialog(CONFIRM, W)!;
    expect(d.title).toBe("Switch model?");
    expect(d.options.map((o) => o.text)).toEqual([
      "1. Yes, switch to Sonnet 5",
      "2. No, go back",
    ]);
    expect(d.selected).toBe(0);
  });

  it("reads a permission prompt, which is a takeover rather than an overlay", () => {
    const d = readDialog(PERMISSION, W)!;
    expect(d.kind).toBe("takeover");
    expect(d.title).toBe("Bash command");
    expect(d.options).toHaveLength(4);
    expect(d.options[3].text).toBe("4. No");
    // The command being approved is prose, not an option.
    expect(d.body.join(" ")).toContain("curl -s https://example.net");
  });
});

describe("dialogs that do not number their options", () => {
  it("reads the trust screen", () => {
    const d = readDialog(TRUST, W)!;
    expect(d.kind).toBe("takeover");
    expect(d.title).toBe("Accessing workspace:");
    expect(d.options.map((o) => o.text)).toEqual([
      "No, exit",
      "Yes, I trust this folder",
    ]);
    expect(d.selected).toBe(0);
  });

  it("reads a one-option list", () => {
    const d = readDialog(FEEDBACK_LIST, W)!;
    expect(d.title).toBe("Feedback drafts");
    expect(d.options.map((o) => o.text)).toEqual(["+ Write new feedback"]);
  });
});

describe("dialogs that want text", () => {
  it("finds an overlay that has no options at all, by the way out it offers", () => {
    // /help and /status are overlays with nothing to choose. They block input
    // exactly as much as any other dialog, and the only thing separating them
    // from the status area is that they say how to leave.
    const help = [
      rule("▔"),
      "   Help  General   Commands   Custom commands",
      "",
      "   /add-dir     Add a new working directory",
      "",
      "   Esc to cancel",
    ].join("\n");
    const d = readDialog(help, W)!;
    expect(d.title).toBe("Help  General   Commands   Custom commands");
    expect(d.options).toEqual([]);
    expect(d.answerable).toBe(false);
  });

  it("takes the key name alone, not the phrase around it", () => {
    // Wordings seen: "Esc to cancel", "Enter to confirm · Esc to cancel",
    // "Esc to cancel · Tab to amend". Matching a phrase would pin cork to one.
    const pane = [rule("▔"), "   Something", "", "   Esc to cancel · Tab to amend"].join("\n");
    expect(readDialog(pane, W)).not.toBeNull();
  });

  it("reports a text-entry dialog as unanswerable", () => {
    const d = readDialog(FEEDBACK_INPUT, W)!;
    expect(d.title).toBe("Submit feedback / bug report");
    expect(d.options).toEqual([]);
    expect(d.answerable).toBe(false);
  });

  it("does not mistake the box drawn inside it for the input box", () => {
    // A field inside a dialog is inset (149 of 155 here) and closed with
    // corners, so it is neither the pane's width nor a single character.
    const d = readDialog(FEEDBACK_INPUT, W);
    expect(d).not.toBeNull();
  });
});

describe("change detection", () => {
  it("signs title and options, so redrawing the same dialog is not news", () => {
    const a = dialogSignature(readDialog(PICKER, W)!);
    const moved = PICKER.replace("   ❯ 1. Default", "     1. Default").replace(
      "     3. Fable",
      "   ❯ 3. Fable"
    );
    // Moving the cursor is not a change worth telling anyone about.
    expect(dialogSignature(readDialog(moved, W)!)).toBe(a);
    expect(dialogSignature(readDialog(CONFIRM, W)!)).not.toBe(a);
  });
});
