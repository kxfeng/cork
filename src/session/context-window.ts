/**
 * How large a model's context window is, so cork can tell how close a session
 * is to being compacted.
 *
 * There is no authoritative source cork can reach. Claude Code hands a
 * `context_window` object (size, tokens used, percentage) to a **statusLine**
 * command, but a hook's stdin carries only session_id, transcript_path, cwd,
 * permission_mode and effort — and the status line itself is the user's own
 * script, not something cork can require. So this maps the model id, which
 * every assistant row in the transcript carries.
 *
 * The list is inverted on purpose: **1M is the default**, and only the models
 * known to have the smaller window get 200K. Every model released with a 1M
 * window since opus-4-7 has kept it, so an unknown id is far more likely to be
 * a newer large-window model than an old small-window one — and being wrong the
 * other way is the expensive mistake, since the warning fires once per window
 * and would be spent at a tenth of the way in.
 *
 * The small-window list is claude code's own, read out of its model definitions
 * (`context: { window }`) at version 2.1.261. Nothing here decides when a
 * compaction happens — claude does that — so being wrong costs one message.
 */

const SMALL_WINDOW = 200_000;
const LARGE_WINDOW = 1_000_000;

/** Model ids whose window is 200K. Prefix match: ids carry date suffixes. */
const SMALL_WINDOW_MODELS = [
  "claude-3-5-haiku",
  "claude-3-5-sonnet",
  "claude-3-7-sonnet",
  "claude-haiku-4-5",
  "claude-opus-4-20",
  "claude-opus-4-1",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-sonnet-4-20",
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
];

/**
 * The window for a model id: 200K for the models known to have it, 1M for
 * everything else, including ids cork has never seen.
 *
 * A `[1m]` suffix wins outright — that is claude's own test for the long
 * window, and it can appear on a model whose default is the smaller one.
 */
export function contextWindowFor(model: string | null | undefined): number {
  if (!model) return LARGE_WINDOW;
  if (/\[1m\]/i.test(model)) return LARGE_WINDOW;
  const id = model.toLowerCase();
  return SMALL_WINDOW_MODELS.some((m) => id.startsWith(m))
    ? SMALL_WINDOW
    : LARGE_WINDOW;
}

export const CONTEXT_WINDOWS = { SMALL_WINDOW, LARGE_WINDOW };
