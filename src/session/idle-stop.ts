/**
 * Deciding when a session has been left alone long enough to stop its pane.
 *
 * Every claude cork keeps up holds about 400MB whether anyone talks to it or
 * not (measured: five sessions, 2.0GB), and a chat that went quiet yesterday
 * still has its process sitting there. Stopping the pane keeps the record, so
 * the next message resumes the same conversation with `claude -r` — and after
 * hours of silence that costs nothing extra: the prompt cache lives an hour,
 * so it would have been cold anyway.
 *
 * The question is only ever "is anything happening here", and each of these
 * answers yes on its own:
 *
 *   claude's status   busy (mid-turn), waiting (a dialog wants a person), or
 *                     shell (a background job is running) — claude's own word,
 *                     from its session registry. `shell` is kept deliberately:
 *                     cork cannot tell a forgotten job from a long one, and
 *                     stopping the pane would kill it.
 *   autopilot         a running task. The watcher would bring the pane
 *                     straight back, so stopping it would only interrupt.
 *   the transcript    grew recently. This is every way in at once: chat
 *                     messages, typing at the terminal, Remote Control, the
 *                     watcher's nudges, and local commands, which write rows
 *                     too (measured for /model, /compact and /exit).
 *   a person typing   an attached client that had a keypress recently. Only a
 *                     keypress moves tmux's client_activity — output and a
 *                     resize do not (measured) — so a browser tab left open
 *                     does not count, and a draft being written does.
 *
 * Pure, so the rules can be tested without a pane, a registry or a clock.
 */

/** How often the sweep runs. The error on the limit is at most this. */
export const IDLE_STOP_CHECK_MS = 10 * 60_000;

/** What the sweep knows about one live pane. */
export interface IdleFacts {
  /** claude's own status, or null when its registry has nothing to say. */
  status: string | null;
  /** Whether an autopilot run is in progress here. */
  autopilot: boolean;
  /**
   * The latest of everything that marks an exchange: the transcript's last
   * write, the last chat message cork delivered, and when the pane itself
   * came up. The last one matters because a pane started over an old
   * transcript — a resume nobody has spoken into yet — has not been idle for
   * the transcript's age; it has been up for minutes.
   */
  lastInteractionAt: number;
  /** When an attached client last had a keypress, or null when none is attached. */
  clientActivityAt: number | null;
}

export type IdleVerdict = { stop: true } | { stop: false; why: string };

export function idleVerdict(f: IdleFacts, now: number, limitMs: number): IdleVerdict {
  // Unknown counts as busy: a registry that cannot be read is not evidence of
  // silence, and the cost of guessing wrong is a turn killed mid-sentence.
  if (f.status !== "idle") return { stop: false, why: `claude is ${f.status ?? "unreadable"}` };
  if (f.autopilot) return { stop: false, why: "autopilot is running" };
  if (now - f.lastInteractionAt < limitMs) return { stop: false, why: "recent activity" };
  if (f.clientActivityAt !== null && now - f.clientActivityAt < limitMs) {
    return { stop: false, why: "someone is typing at the terminal" };
  }
  return { stop: true };
}

/** The configured limit in ms, or null when stopping idle sessions is off. */
export function idleLimitMs(hours: number | undefined): number | null {
  if (hours === undefined || !Number.isFinite(hours) || hours <= 0) return null;
  return hours * 3_600_000;
}
