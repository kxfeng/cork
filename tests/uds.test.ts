import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UdsServer, type CommandMessage } from "../src/daemon/uds-server.js";
import { UdsClient } from "../src/channel-mcp/uds-client.js";

/**
 * Integration test for the UDS protocol between cork daemon and channel MCP.
 *
 * These tests validate the JSON-line protocol directly using raw net.Socket
 * connections, independent of the actual UDS server/client implementation.
 * Once uds-server.ts and uds-client.ts are implemented, these tests serve
 * as a regression suite for the protocol contract.
 */

const testDir = path.join(os.tmpdir(), `cork-test-uds-${process.pid}`);
const sockPath = path.join(testDir, "test.sock");

interface UdsMessage {
  type: string;
  [key: string]: unknown;
}

function createTestServer(): net.Server {
  const server = net.createServer({ allowHalfOpen: false });
  server.listen(sockPath);
  return server;
}

function connectClient(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(sockPath, () => resolve(client));
    client.on("error", reject);
  });
}

function sendJson(socket: net.Socket, msg: UdsMessage): void {
  socket.write(JSON.stringify(msg) + "\n");
}

/** Same reasoning as command-spool's `until`: an anti-hang guard, not a speed
 *  assertion. Raised with it, on the same grounds — this one has not been seen
 *  to fire, but it waits on the same kind of event with the same tight budget. */
function readJson(socket: net.Socket, timeoutMs = 15_000): Promise<UdsMessage> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.removeAllListeners("data");
      reject(new Error("readJson timed out"));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx >= 0) {
        clearTimeout(timer);
        socket.removeListener("data", onData);
        resolve(JSON.parse(buffer.slice(0, newlineIdx)));
      }
    };
    socket.on("data", onData);
  });
}

describe("UDS Protocol", () => {
  let server: net.Server;

  beforeEach(() => {
    fs.mkdirSync(testDir, { recursive: true });
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
    server = createTestServer();
  });

  afterEach(async () => {
    server.close();
    // Force close all open connections to avoid hanging
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      setTimeout(resolve, 100);
    });
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("client can connect and send register message", async () => {
    const serverGotMessage = new Promise<UdsMessage>((resolve) => {
      server.on("connection", (conn) => {
        readJson(conn).then(resolve);
      });
    });

    const client = await connectClient();
    sendJson(client, { type: "register", corkSessionKey: "lark_oc_xxx" });

    const msg = await serverGotMessage;
    expect(msg.type).toBe("register");
    expect(msg.corkSessionKey).toBe("lark_oc_xxx");

    client.destroy();
  });

  it("server can send message to registered client", async () => {
    const clientReady = new Promise<net.Socket>((resolve) => {
      server.on("connection", (conn) => {
        readJson(conn).then(() => resolve(conn));
      });
    });

    const client = await connectClient();
    sendJson(client, { type: "register", corkSessionKey: "lark_oc_xxx" });

    const serverConn = await clientReady;
    sendJson(serverConn, {
      type: "message",
      content: "hello from lark",
      meta: { chatId: "oc_xxx", senderId: "ou_xxx", messageId: "om_xxx" },
    });

    const msg = await readJson(client);
    expect(msg.type).toBe("message");
    expect(msg.content).toBe("hello from lark");
    expect((msg.meta as any).chatId).toBe("oc_xxx");

    client.destroy();
  });

  it("client can send reply back to server", async () => {
    const serverGotReply = new Promise<UdsMessage>((resolve) => {
      server.on("connection", (conn) => {
        // First message is register, second is reply
        readJson(conn).then(() => readJson(conn).then(resolve));
      });
    });

    const client = await connectClient();
    sendJson(client, { type: "register", corkSessionKey: "lark_oc_xxx" });

    // Small delay to ensure register is processed
    await delay(50);

    sendJson(client, {
      type: "reply",
      corkSessionKey: "lark_oc_xxx",
      content: "claude's response",
      streaming: false,
    });

    const msg = await serverGotReply;
    expect(msg.type).toBe("reply");
    expect(msg.content).toBe("claude's response");

    client.destroy();
  });

  it("server handles multiple concurrent clients", async () => {
    const connections: net.Socket[] = [];
    const registered: string[] = [];

    server.on("connection", (conn) => {
      connections.push(conn);
      readJson(conn).then((msg) => {
        registered.push(msg.corkSessionKey as string);
      });
    });

    const client1 = await connectClient();
    sendJson(client1, { type: "register", corkSessionKey: "lark_oc_aaa" });

    const client2 = await connectClient();
    sendJson(client2, { type: "register", corkSessionKey: "lark_oc_bbb" });

    await delay(100);

    expect(registered).toHaveLength(2);
    expect(registered).toContain("lark_oc_aaa");
    expect(registered).toContain("lark_oc_bbb");

    client1.destroy();
    client2.destroy();
  });

  it("client socket becomes unwritable after destroy", async () => {
    server.on("connection", () => {});

    const client = await connectClient();
    sendJson(client, { type: "register", corkSessionKey: "lark_oc_xxx" });
    await delay(50);

    client.destroy();
    await delay(50);

    expect(client.destroyed).toBe(true);
    expect(client.writable).toBe(false);
  });

});

/**
 * The one exchange on this socket that is a request with an answer: the
 * model's `cork` tool sends a command and the tool call returns what the daemon
 * said. Tested with the real client and server, since the correlation by
 * requestId is theirs.
 */
describe("commands over UDS", () => {
  const dir = path.join(os.tmpdir(), `cork-test-uds-cmd-${process.pid}`);
  const sock = path.join(dir, "cmd.sock");
  let server: UdsServer;
  let client: UdsClient;

  beforeEach(async () => {
    fs.mkdirSync(dir, { recursive: true });
    server = new UdsServer(sock);
    await server.start();
    client = new UdsClient(sock, "sess-cmd");
    await client.connect();
  });

  afterEach(async () => {
    client.disconnect();
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("answers a command on the same socket, matched by requestId", async () => {
    server.on("command", (msg: CommandMessage) => {
      server.sendToChannel(msg.corkSessionKey, {
        type: "command-result",
        requestId: msg.requestId,
        ok: msg.command === "autopilot done",
        text: `got ${msg.command}`,
      });
    });
    await delay(50); // let the register land

    const res = await client.request({ type: "command", corkSessionKey: "sess-cmd", command: "autopilot done" });
    expect(res.ok).toBe(true);
    expect(res.text).toBe("got autopilot done");

    const refused = await client.request({ type: "command", corkSessionKey: "sess-cmd", command: "nonsense" });
    expect(refused.ok).toBe(false);
  });

  it("gives up when nothing answers", async () => {
    await delay(50);
    await expect(
      client.request({ type: "command", corkSessionKey: "sess-cmd", command: "x" }, 200)
    ).rejects.toThrow(/no answer/);
  });

  it("ignores a command that names a session other than the one on the socket", async () => {
    // Found in review: anything that can open the socket could otherwise start
    // an evaluation for any session by naming it.
    const seen: string[] = [];
    server.on("command", (msg: CommandMessage) => seen.push(msg.corkSessionKey));
    await delay(50);
    await expect(
      client.request({ type: "command", corkSessionKey: "somebody-else", command: "autopilot done" }, 200)
    ).rejects.toThrow(/no answer/);
    expect(seen).toEqual([]);
  });

  it("fails pending requests at once when cork goes away", async () => {
    await delay(50);
    const p = client.request({ type: "command", corkSessionKey: "sess-cmd", command: "autopilot done" }, 10_000);
    await server.stop();
    await expect(p).rejects.toThrow(/disconnected|ECONNRESET|EPIPE/);
  });

  it("does not mistake a result for an inbound message", async () => {
    const inbound: unknown[] = [];
    client.on("message", (m) => inbound.push(m));
    server.on("command", (msg: CommandMessage) => {
      server.sendToChannel(msg.corkSessionKey, {
        type: "command-result",
        requestId: msg.requestId,
        ok: true,
        text: "ok",
      });
    });
    await delay(50);
    await client.request({ type: "command", corkSessionKey: "sess-cmd", command: "autopilot done" });
    expect(inbound).toEqual([]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
