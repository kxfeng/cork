import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  formatLeafContent,
  mediaRetry,
  type FormatChannel,
} from "../src/channels/lark/message-format.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const image = (id: string) => ({
  messageId: id,
  msgType: "image",
  content: JSON.stringify({ image_key: `img_${id}` }),
});
const httpError = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status },
  });

/** A channel whose downloads fail with `errors` in turn, then succeed. */
function flaky(errors: unknown[]) {
  const calls: string[] = [];
  const channel: FormatChannel = {
    async downloadResource(messageId) {
      calls.push(messageId);
      const err = errors.shift();
      if (err) throw err;
      return { buffer: PNG };
    },
  };
  return { channel, calls };
}

describe("media download retry", () => {
  const saved = { ...mediaRetry };
  beforeEach(() => {
    mediaRetry.delayMs = 0;
  });
  afterEach(() => {
    Object.assign(mediaRetry, saved);
  });

  it("recovers from a 500 on a later attempt", async () => {
    const { channel, calls } = flaky([httpError(500), httpError(502)]);
    const out = await formatLeafContent(channel, image("m1"));
    expect(out).toMatch(/^!\[\]\(.*m1_/);
    expect(calls).toEqual(["m1", "m1", "m1"]);
  });

  it("gives up after three attempts in all", async () => {
    const { channel, calls } = flaky([500, 500, 500, 500].map(httpError));
    const out = await formatLeafContent(channel, image("m2"));
    expect(out).toBe("[image: <unavailable>]");
    expect(calls).toHaveLength(3);
  });

  it("retries a request that got no response", async () => {
    const timeout = Object.assign(new Error("timeout"), { isAxiosError: true });
    const { channel, calls } = flaky([timeout]);
    const out = await formatLeafContent(channel, image("m3"));
    expect(out).toMatch(/^!\[\]/);
    expect(calls).toHaveLength(2);
  });

  it("moves to the next candidate id on a 4xx without retrying", async () => {
    const { channel, calls } = flaky([httpError(400)]);
    const out = await formatLeafContent(channel, image("sub"), "outer");
    expect(out).toMatch(/outer_/);
    expect(calls).toEqual(["sub", "outer"]);
  });
});
