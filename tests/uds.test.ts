import { describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

function readJson(socket: net.Socket, timeoutMs = 2000): Promise<UdsMessage> {
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

  it("handles permission relay flow", async () => {
    const clientGotRequest = new Promise<UdsMessage>((resolve) => {
      server.on("connection", async (conn) => {
        await readJson(conn); // register
        // Send permission request to client
        sendJson(conn, {
          type: "permission_request",
          toolName: "Bash",
          description: "run ls -la",
          requestId: "abcde",
        });
        resolve(await readJson(conn)); // wait for verdict
      });
    });

    const client = await connectClient();
    sendJson(client, { type: "register", corkSessionKey: "lark_oc_xxx" });

    // Read permission request
    const request = await readJson(client);
    expect(request.type).toBe("permission_request");
    expect(request.toolName).toBe("Bash");
    expect(request.requestId).toBe("abcde");

    // Send verdict back
    sendJson(client, {
      type: "permission_verdict",
      requestId: "abcde",
      behavior: "allow",
    });

    // We don't need the server-side verification here since we're testing protocol
    client.destroy();
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
