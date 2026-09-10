import { describe, it, expect, vi } from "vitest";
import { getBotInfo } from "../src/channels/lark/client.js";
import { LarkChannel } from "../src/channels/lark/index.js";

/**
 * The bot's own open id gates every @mention check. When it is missing, the
 * bot cannot tell that it was named — so in any group that requires a mention,
 * every message is discarded. That state used to be permanent: one flaky call
 * during startup and the daemon stayed deaf until someone restarted it, with
 * nothing but a line in the debug log to say why.
 */

/** A Lark client stub whose `request` plays out the given per-call outcomes. */
function clientReturning(...outcomes: Array<unknown | Error>): {
  client: any;
  calls: () => number;
} {
  let i = 0;
  const request = vi.fn(async () => {
    const outcome = outcomes[Math.min(i, outcomes.length - 1)];
    i++;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { client: { request }, calls: () => request.mock.calls.length };
}

const OK = { bot: { open_id: "ou_self", app_name: "XiaoK" } };

describe("getBotInfo", () => {
  it("returns the identity on the first try", async () => {
    const { client, calls } = clientReturning(OK);
    expect(await getBotInfo(client, 3)).toEqual({
      openId: "ou_self",
      name: "XiaoK",
    });
    expect(calls()).toBe(1);
  });

  it("retries a throwing call and succeeds", async () => {
    const { client, calls } = clientReturning(new Error("network"), OK);
    expect((await getBotInfo(client, 3)).openId).toBe("ou_self");
    expect(calls()).toBe(2);
  });

  it("retries a call that succeeds but carries no open id", async () => {
    // The failure that actually happened: a well-formed response missing the
    // one field we came for. Treating it as success is what left the daemon
    // deaf, so it has to count as a miss.
    const { client, calls } = clientReturning({ bot: { app_name: "XiaoK" } }, OK);
    expect((await getBotInfo(client, 3)).openId).toBe("ou_self");
    expect(calls()).toBe(2);
  });

  it("gives up after the requested number of tries", async () => {
    const { client, calls } = clientReturning(new Error("down"));
    expect(await getBotInfo(client, 3)).toEqual({ openId: "", name: "bot" });
    expect(calls()).toBe(3);
  });

  it("tries once when no count is given", async () => {
    const { client, calls } = clientReturning(new Error("down"));
    expect((await getBotInfo(client)).openId).toBe("");
    expect(calls()).toBe(1);
  });
});

/**
 * The late-resolution path, driven through the real LarkChannel with its
 * transport swapped out — a hand-rolled copy of the method would keep passing
 * after the original drifted.
 */
function channelWith(client: any): LarkChannel {
  const ch = new LarkChannel({
    appId: "cli_test",
    appSecret: "secret",
    domain: "feishu",
    owners: [],
    ackEmoji: "",
    idleTimeoutMin: 0,
  });
  (ch as any).client = client;
  return ch;
}

describe("late identity resolution", () => {
  it("does not call out when the id is already known", async () => {
    const { client, calls } = clientReturning(OK);
    const ch = channelWith(client);
    ch.botOpenId = "ou_cached";
    expect(await ch.ensureBotOpenId()).toBe("ou_cached");
    expect(calls()).toBe(0);
  });

  it("fetches on demand and remembers the result", async () => {
    const { client, calls } = clientReturning(OK);
    const ch = channelWith(client);
    expect(await ch.ensureBotOpenId()).toBe("ou_self");
    expect(ch.botName).toBe("XiaoK");
    await ch.ensureBotOpenId();
    expect(calls()).toBe(1); // second call served from memory
  });

  it("shares one request across a burst of callers", async () => {
    // Messages arrive in bursts; without sharing, a still-broken lookup would
    // fire once per message.
    const { client, calls } = clientReturning(OK);
    const ch = channelWith(client);
    const results = await Promise.all([
      ch.ensureBotOpenId(),
      ch.ensureBotOpenId(),
      ch.ensureBotOpenId(),
    ]);
    expect(results).toEqual(["ou_self", "ou_self", "ou_self"]);
    expect(calls()).toBe(1);
  });

  it("stays empty on failure and tries again next time", async () => {
    // A failed attempt must not latch: the point of resolving late is that the
    // next message gets another chance.
    const failing = vi.fn(async () => {
      throw new Error("down");
    });
    const ch = channelWith({ request: failing });
    expect(await ch.ensureBotOpenId()).toBe("");
    expect(await ch.ensureBotOpenId()).toBe("");
    expect(failing.mock.calls.length).toBe(2);
  });
});
