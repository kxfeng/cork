import { describe, it, expect } from "vitest";
import { dialogAction, commandIsAtPrompt, looksLikeDialog } from "../src/session/manager.js";

/**
 * Claude shows several prompts before a session is usable, in no fixed order
 * and not all of them every time, and they are not answered the same way.
 * Getting one wrong is fatal and silent:
 *
 * The trust prompt ("is this a project you trust?") appears for any workspace
 * claude has not been run in before — `/new <a new path>`, a fresh clone, a
 * temp dir in a test — and its default option is **"No, exit"**. Answering it
 * with a bare Enter quits claude, and the session dies at startup with nothing
 * but cork's 30-second "failed to start" to show for it.
 */

const TRUST_PANE = `
 Accessing workspace:

 /tmp/some/new/dir

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a
 well-known open source project, or work from your team).

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel
`;

const DEV_CHANNEL_PANE = `
 Loading development channels

 server:cork-channel

 ❯ Yes, I am using this for local development
   No, exit
`;

/**
 * Claude shows this when resuming a session that is old and large. Its default
 * is the summary, which for a cork session — one continuous conversation from
 * the user's side — means the model has forgotten what it said an hour ago.
 */
const RESUME_PANE = `
 This session is 4h 32m old and 226.2k tokens.

 Resuming the full session will consume a substantial portion of your usage limits. We
 recommend resuming from a summary.

 ❯ 1. Resume from summary (recommended)
   2. Resume full session as-is
   3. Don't ask me again

 Enter to confirm · Esc to cancel
`;

const READY_PANE = `
❯ Try "refactor <filepath>"
  Opus 5 (1M context) | Context: 0/1M 0%
  -- INSERT -- ⏵⏵ bypass permissions on
`;

describe("dialogAction", () => {
  it("answers the dev-channel prompt, whose default is already right", () => {
    expect(dialogAction(DEV_CHANNEL_PANE)).toEqual({ dialog: "dev-channel", moves: 0 });
  });

  it("moves down to the trust prompt's yes", () => {
    expect(dialogAction(TRUST_PANE)).toEqual({ dialog: "trust", moves: 1 });
  });

  it("takes the full session when offered a summary instead", () => {
    // Found the hard way: cork did not know this prompt, waited out its
    // dialog timeout, decided the session had started, and typed `/goal`
    // into the dialog.
    expect(dialogAction(RESUME_PANE)).toEqual({ dialog: "resume", moves: 1 });
  });

  it("still picks the full session when it is listed first", () => {
    // The option cork wants is named, not counted. Where claude puts it in the
    // list is claude's business and may change between versions.
    const reordered = RESUME_PANE.replace(
      " ❯ 1. Resume from summary (recommended)\n   2. Resume full session as-is",
      " ❯ 1. Resume full session as-is\n   2. Resume from summary (recommended)"
    );
    expect(dialogAction(reordered)).toEqual({ dialog: "resume", moves: 0 });
  });

  it("still picks yes when the trust options are the other way round", () => {
    // Counting instead of reading would send Down here and select "No, exit",
    // which quits claude.
    const reordered = TRUST_PANE.replace(
      " ❯ No, exit\n   Yes, I trust this folder",
      " ❯ Yes, I trust this folder\n   No, exit"
    );
    expect(dialogAction(reordered)).toEqual({ dialog: "trust", moves: 0 });
  });

  it("finds an option further down the list", () => {
    const three = TRUST_PANE.replace(
      "   Yes, I trust this folder",
      "   Some other option\n   Yes, I trust this folder"
    );
    expect(dialogAction(three)).toEqual({ dialog: "trust", moves: 2 });
  });

  it("does nothing on a prompt that is ready for input", () => {
    expect(dialogAction(READY_PANE)).toBeNull();
    expect(dialogAction("")).toBeNull();
  });

  it("does not mistake ordinary output mentioning one option for the prompt", () => {
    expect(dialogAction("the log said No, exit was chosen")).toBeNull();
  });

  it("gives up rather than guess when the wanted option is not on screen", () => {
    // A dialog cork half-recognises is still a dialog cork cannot answer. The
    // caller reports it to the user instead of pressing keys into it.
    const changed = TRUST_PANE.replace("Yes, I trust this folder", "Sure, go ahead");
    expect(dialogAction(changed)).toBeNull();
  });
});

/**
 * How the startup poll tells a question it cannot answer from a screen that is
 * simply still drawing itself. Cork does not try to recognise the input
 * interface — the channel MCP registering is what says claude is up — so this
 * is only ever used to decide whether to interrupt the user.
 */
describe("looksLikeDialog", () => {
  it("spots a numbered choice list", () => {
    expect(looksLikeDialog(RESUME_PANE)).toBe(true);
    expect(looksLikeDialog("  ❯ 1. Something cork has never seen\n    2. Or this")).toBe(true);
  });

  it("does not call a half-drawn startup screen a dialog", () => {
    expect(looksLikeDialog("")).toBe(false);
    expect(looksLikeDialog(" ✻ Welcome to Claude Code\n\n   /help for help")).toBe(false);
    expect(looksLikeDialog(READY_PANE)).toBe(false);
  });
});

/**
 * Before submitting, cork checks that what it typed is at the START of the
 * input line. Anything already in the box pushes the command along it, and a
 * `/goal` that is not first is not a command — it is sent as an ordinary chat
 * message, silently. An end-to-end run found the box holding a line no part of
 * cork had put there, so this is not hypothetical.
 */
describe("commandIsAtPrompt", () => {
  const pane = (inputLine: string) =>
    [
      "● Some earlier output",
      "❯ Goal set: an older goal", // claude prefixes OUTPUT with ❯ too
      "─".repeat(40),
      inputLine,
      "─".repeat(40),
      "  Opus 5 | Context: 42K/1M 4%",
    ].join("\n");

  it("accepts the command sitting at the front of the input", () => {
    expect(commandIsAtPrompt(pane("❯ /goal do the thing"), "/goal do the thing")).toBe(true);
  });

  it("rejects it when something else got there first", () => {
    expect(
      commandIsAtPrompt(pane("❯ leftover text /goal do the thing"), "/goal do the thing")
    ).toBe(false);
  });

  it("reads the LAST ❯ line, not the first", () => {
    // The first one is command output. Matching on it is how this went wrong.
    expect(commandIsAtPrompt(pane("❯ /goal do the thing"), "/goal do the thing")).toBe(true);
    expect(commandIsAtPrompt(pane("❯ "), "/goal do the thing")).toBe(false);
  });

  it("tolerates a long command being wrapped by the pane", () => {
    const long = "/goal " + "x".repeat(300);
    expect(commandIsAtPrompt(pane("❯ " + long.slice(0, 120)), long)).toBe(true);
  });

  it("says no when there is no prompt at all", () => {
    expect(commandIsAtPrompt("", "/goal x")).toBe(false);
  });
});
