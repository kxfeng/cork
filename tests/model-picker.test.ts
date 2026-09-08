import { describe, it, expect } from "vitest";
import {
  parseModelPicker,
  chooseModelRow,
  switchConfirmYes,
  lastModelNotice,
} from "../src/session/model-picker.js";

/** Every frame claude draws spans exactly the pane's width. */
const W = 155;
const rule = (ch: string) => ch.repeat(W);

/**
 * The fixtures are pane text captured off a real session, not written by hand:
 * the column widths, the "✔" on the current row and the exact footer are the
 * things the parser keys on, and inventing them would test the invention.
 */
const PICKER = `
${rule("▔")}
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
     2. Opus (1M context)      Opus 5 with 1M context · Best for everyday, complex tasks
     3. Fable                  Fable 5.1 · Most capable for your hardest and longest-running tasks
   ❯ 4. Sonnet ✔               Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   ● High effort (default) ←/→ to adjust

   Use /fast to turn on Fast mode (Opus 5).

   Enter to set as default · s to use this session only · Esc to cancel
`;

const CONFIRM = `
${rule("▔")}
   Switch model?
   Your next response will be slower and use more tokens

   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.

   ❯ 1. Yes, switch to Sonnet 5
     2. No, go back
`;

const IDLE = `
❯ /model sonnet
${rule("─")}
❯
${rule("─")}
  Fable 5.1 | Context: ▒▒▒▒▒ 24K/1M 2%
  ⏸ manual mode on · ← for agents
`;

describe("reading the picker", () => {
  it("finds every row, the cursor and the current model", () => {
    const v = parseModelPicker(PICKER, W)!;
    expect(v.rows.map((r) => r.label)).toEqual([
      "Default (recommended)",
      "Opus (1M context)",
      "Fable",
      "Sonnet",
      "Haiku",
    ]);
    expect(v.cursor).toBe(3);
    expect(v.rows[3].current).toBe(true);
    expect(v.rows[2].modelName).toBe("Fable 5.1");
  });

  it("is not fooled by the other numbered list on screen", () => {
    // The confirmation is also "❯ 1. …", and pressing `s` into it would answer
    // a question nobody read. Only the picker's own footer admits a picker.
    expect(parseModelPicker(CONFIRM, W)).toBeNull();
    expect(parseModelPicker(IDLE, W)).toBeNull();
  });

  it("says nothing rather than half a view while the frame is drawing", () => {
    const footerOnly =
      "   Enter to set as default · s to use this session only · Esc to cancel";
    expect(parseModelPicker(footerOnly)).toBeNull();
  });
});

describe("choosing a row", () => {
  const rows = parseModelPicker(PICKER, W)!.rows;

  it("takes a family word", () => {
    const c = chooseModelRow(rows, "fable");
    expect(c.ok && c.row.label).toBe("Fable");
    expect(c.ok && c.index).toBe(2);
  });

  it("is case- and space-insensitive", () => {
    expect(chooseModelRow(rows, "  HAIKU ").ok).toBe(true);
  });

  it("takes the label in full, so a model cork has never heard of still works", () => {
    const c = chooseModelRow(rows, "Opus (1M context)");
    expect(c.ok && c.index).toBe(1);
  });

  it("takes the concrete model name too", () => {
    const c = chooseModelRow(rows, "Fable 5.1");
    expect(c.ok && c.index).toBe(2);
  });

  it("prefers an exact label over a family word that also matches", () => {
    // Both "Opus" and "Opus (1M context)" can be on screen at once.
    const both = parseModelPicker(
      PICKER.replace(
        "     5. Haiku                  Haiku 4.5",
        "     5. Opus                   Opus 5 · Best for everyday, complex tasks\n     6. Haiku                  Haiku 4.5"
      ),
      W
    )!.rows;
    const c = chooseModelRow(both, "opus");
    expect(c.ok && c.row.label).toBe("Opus");
  });

  it("refuses an ambiguous family word instead of picking one", () => {
    // Neither row is called plain "Fable", so the family word is all there is
    // to go on and it reaches both. Position is not a tiebreak.
    const twoFables = [
      { ...rows[2], n: 3, label: "Fable (1M context)", modelName: "Fable 5.1" },
      { ...rows[2], n: 4, label: "Fable (fast)", modelName: "Fable 5.1" },
    ];
    const c = chooseModelRow(twoFables, "fable");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toMatch(/more than one/);
      expect(c.options).toEqual([
        "Fable (1M context) (Fable 5.1)",
        "Fable (fast) (Fable 5.1)",
      ]);
    }
  });

  it("refuses an unknown name and hands back what was on screen", () => {
    const c = chooseModelRow(rows, "gpt");
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.reason).toMatch(/no model here is called/);
      expect(c.options).toContain("Haiku (Haiku 4.5)");
    }
  });

  it("never lands a family request on the Default row", () => {
    // Default renders as Opus here; asking for "opus" must reach the real
    // Opus row, and asking for a family Default happens to show must not be
    // answered by a row that only follows the settings file.
    const c = chooseModelRow(rows, "opus");
    expect(c.ok && c.row.label).toBe("Opus (1M context)");
  });

  it("reaches Default only by name", () => {
    const c = chooseModelRow(rows, "default");
    expect(c.ok && c.row.label).toBe("Default (recommended)");
  });
});

describe("the confirmation and what claude says it did", () => {
  it("finds which option says Yes", () => {
    // An index, not a key: the answer is given by walking the cursor there,
    // the same way every other dialog is answered.
    expect(switchConfirmYes(CONFIRM, W)).toBe(0);
  });

  it("is absent when no confirmation is up", () => {
    expect(switchConfirmYes(PICKER, W)).toBeNull();
    expect(switchConfirmYes(IDLE, W)).toBeNull();
  });

  it("takes claude's own word for what a /model did", () => {
    // The three shapes, captured off a real pane. The name is taken whole:
    // "(1M context)" and a trailing "(default)" are part of what claude calls
    // the model, and trimming either would name a different row.
    const pane = [
      "❯ /model",
      "  \u23BF  Kept model as Opus 5 (1M context)",
      "❯ /model",
      "  \u23BF  Set model to Fable 5.1 for this session only",
      "❯ /model",
      "  \u23BF  Set model to Opus 5 (1M context) (default) for this session only",
    ].join("\n");
    expect(lastModelNotice(pane)).toMatchObject({
      kind: "set",
      model: "Opus 5 (1M context) (default)",
    });
  });

  it("reads the one that did not switch as such", () => {
    const pane = "  \u23BF  Kept model as Opus 5 (1M context)";
    expect(lastModelNotice(pane)).toMatchObject({
      kind: "kept",
      model: "Opus 5 (1M context)",
    });
  });

  it("does not read prose in the conversation as a result line", () => {
    // cork's own messages are drawn in the same pane. Only the "⎿" claude puts
    // under a command's result makes a line a result.
    const pane = [
      "● I would say: Set model to Fable 5.1 for this session only",
      "  Kept model as Opus 5 (1M context) is the other shape.",
    ].join("\n");
    expect(lastModelNotice(pane)).toBeNull();
  });

  it("has nothing to say about a pane where no /model has run", () => {
    expect(lastModelNotice(IDLE)).toBeNull();
  });
});
