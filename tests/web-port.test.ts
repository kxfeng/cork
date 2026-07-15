import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import { findFreePort } from "../src/web/port.js";

describe("findFreePort", () => {
  let held: net.Server | null = null;

  afterEach(async () => {
    if (held) {
      await new Promise((r) => held!.close(r));
      held = null;
    }
  });

  beforeEach(() => {
    held = null;
  });

  it("returns the wanted port when it is free", async () => {
    // Ask the OS for a free one, release it, then claim it back by number.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));

    expect(await findFreePort(port)).toBe(port);
  });

  it("steps past a port that is taken", async () => {
    held = net.createServer();
    await new Promise<void>((r) => held!.listen(0, "127.0.0.1", () => r()));
    const taken = (held.address() as net.AddressInfo).port;

    const got = await findFreePort(taken);
    expect(got).not.toBe(taken);
    expect(got).toBeGreaterThan(taken);
  });
});
