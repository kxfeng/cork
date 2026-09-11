import { describe, it, expect } from "vitest";
import { usableAtTargets } from "../src/channels/lark/mentions.js";

/**
 * Which ids can carry an @mention.
 *
 * Measured, not assumed: the same message sent with `<at id=cli_…></at>` came
 * back from Lark with `mentions: null` and the tag parsed as `text`, while the
 * open-id form came back as `tag: "at"` and rendered as a blue, clickable
 * @name. So an app id does not merely fail to notify — it puts raw markup in
 * front of everyone in the chat.
 *
 * That matters because a bot has both an open id and an app id, so which one a
 * caller is holding decides whether the mention lands. An app id arriving here
 * is an ordinary outcome rather than a caller error, and dropping it is the
 * whole job.
 */

const SELF_OPEN = "ou_self";
const SELF_APP = "cli_self";

describe("usableAtTargets", () => {
  it("keeps an open id", () => {
    expect(usableAtTargets(["ou_alice"])).toEqual(["ou_alice"]);
  });

  it("drops an app id rather than rendering it as markup", () => {
    expect(usableAtTargets(["cli_coko"])).toEqual([]);
  });

  it("keeps the bot's own open id", () => {
    // Mentioning yourself notifies nobody, but it is not an error, and a
    // caller that means something by it is not overruled here. Measured:
    // Lark accepts it and renders the mention like any other.
    expect(usableAtTargets([SELF_OPEN])).toEqual([SELF_OPEN]);
  });

  it("drops the bot's own app id, like any other app id", () => {
    expect(usableAtTargets([SELF_APP])).toEqual([]);
  });

  it("keeps the usable ids out of a mixed list", () => {
    expect(
      usableAtTargets(["ou_alice", "cli_coko", SELF_OPEN, "ou_bob"])
    ).toEqual(["ou_alice", SELF_OPEN, "ou_bob"]);
  });

  it("mentions someone once even when named twice", () => {
    expect(usableAtTargets(["ou_alice", "ou_alice"])).toEqual(["ou_alice"]);
  });

  it("ignores empty and missing entries", () => {
    expect(usableAtTargets([undefined, "", "ou_alice"])).toEqual(["ou_alice"]);
  });

  it("returns nothing for an empty list", () => {
    expect(usableAtTargets([])).toEqual([]);
  });
});
