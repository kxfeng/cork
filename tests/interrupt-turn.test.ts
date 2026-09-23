import { describe, it, expect } from "vitest";
import { interruptTurn } from "../src/session/manager.js";

/**
 * interruptTurn presses Escape one at a time, only while claude says it is
 * busy. Blind presses opened the Rewind dialog: two Escapes on an idle prompt
 * within ~0.8s mean "rewind", and a busy pane turns idle after the first.
 */
function pane(statuses: Array<string | null>, flipAfterPress: Array<number>) {
  // `statuses[i]` is what the registry says after i presses; each press
  // takes effect `flipAfterPress[i]` ms after it is sent.
  let t = 0;
  const pressedAt: number[] = [];
  return {
    pressedAt,
    deps: {
      status: () => {
        let n = 0;
        pressedAt.forEach((at, i) => {
          if (t >= at + (flipAfterPress[i] ?? 0)) n = i + 1;
        });
        return statuses[Math.min(n, statuses.length - 1)];
      },
      press: () => {
        pressedAt.push(t);
        return true;
      },
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
    },
  };
}

describe("interruptTurn", () => {
  it("presses nothing on an idle pane", async () => {
    const p = pane(["idle"], []);
    expect(await interruptTurn(p.deps)).toBe(0);
  });

  it("presses nothing while a background shell runs", async () => {
    const p = pane(["shell"], []);
    expect(await interruptTurn(p.deps)).toBe(0);
  });

  it("presses once to cancel a dialog the clear could not get past", async () => {
    // Typed into a question, `/goal clear` + Enter answered it with the
    // highlighted option. One Escape cancels it and ends the turn.
    const p = pane(["waiting", "shell"], [150]);
    expect(await interruptTurn(p.deps)).toBe(1);
  });

  it("keeps each press outside the double-press window through a run of dialogs", async () => {
    const p = pane(["waiting", "waiting", "busy", "idle"], [100, 100, 150]);
    expect(await interruptTurn(p.deps)).toBe(3);
    for (let i = 1; i < p.pressedAt.length; i++) {
      expect(p.pressedAt[i] - p.pressedAt[i - 1]).toBeGreaterThanOrEqual(800);
    }
  });

  it("presses nothing when the status cannot be read", async () => {
    const p = pane([null], []);
    expect(await interruptTurn(p.deps)).toBe(0);
  });

  it("presses once when the turn ends on the first press", async () => {
    // Measured: busy → idle 0.15s after one Escape.
    const p = pane(["busy", "idle"], [150]);
    expect(await interruptTurn(p.deps)).toBe(1);
  });

  it("presses again for vim, and never inside the double-press window", async () => {
    // First press only leaves INSERT; the second interrupts.
    const p = pane(["busy", "busy", "idle"], [0, 150]);
    expect(await interruptTurn(p.deps)).toBe(2);
    expect(p.pressedAt[1] - p.pressedAt[0]).toBeGreaterThanOrEqual(800);
  });

  it("stops at three presses on a pane that stays busy", async () => {
    const p = pane(["busy"], []);
    expect(await interruptTurn(p.deps)).toBe(3);
    for (let i = 1; i < p.pressedAt.length; i++) {
      expect(p.pressedAt[i] - p.pressedAt[i - 1]).toBeGreaterThanOrEqual(800);
    }
  });

  it("stops when the pane goes away", async () => {
    const p = pane(["busy"], []);
    p.deps.press = () => false;
    expect(await interruptTurn(p.deps)).toBe(0);
  });
});
