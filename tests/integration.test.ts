import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TestChannel } from "../src/channels/test/index.js";
import { CorkDaemon } from "../src/daemon/daemon.js";
import { paths } from "../src/config/paths.js";
import type { CorkConfig } from "../src/config/schema.js";

// Use a unique temp dir for each test run
function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `cork-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(workspace: string): CorkConfig {
  return {
    defaultWorkspace: workspace,
    claude: {
      permissionMode: "bypassPermissions",
      extraArgs: [],
    },
    channels: {},
  };
}

describe("Cork Integration Tests", () => {
  let tempDir: string;
  let channel: TestChannel;
  let daemon: CorkDaemon;

  beforeEach(() => {
    tempDir = makeTempDir();
    channel = new TestChannel();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
    }
    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
    // Clean up test session files (chatId starts with "test-")
    if (fs.existsSync(paths.sessionsDir)) {
      for (const file of fs.readdirSync(paths.sessionsDir)) {
        if (!file.endsWith(".json")) continue;
        const filePath = path.join(paths.sessionsDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.chatId?.startsWith("test-")) {
            fs.unlinkSync(filePath);
          }
        } catch { /* ignore */ }
      }
    }
  });

  it("single message → receives reply", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    await channel.injectMessage({
      text: "respond with exactly the word: pong",
      chatId: "test-chat-single",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);

    const lastReply = replies[replies.length - 1];
    expect(lastReply.content.toLowerCase()).toContain("pong");
  }, 60000);

  it("multi-turn conversation preserves context", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    // Turn 1: tell Claude a number
    await channel.injectMessage({
      text: "remember this number: 42. respond with just: ok",
      chatId: "test-chat-multi",
    });

    let replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);

    channel.clearReplies();

    // Turn 2: ask Claude to recall
    await channel.injectMessage({
      text: "what number did I tell you? respond with just the number.",
      chatId: "test-chat-multi",
    });

    replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);

    const lastReply = replies[replies.length - 1];
    expect(lastReply.content).toContain("42");
  }, 120000);

  it("different chats have isolated sessions", async () => {
    // Use separate workspace dirs to avoid Claude sharing project-level context
    const wsA = path.join(tempDir, "workspace-a");
    const wsB = path.join(tempDir, "workspace-b");
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    // Chat A uses workspace A
    await channel.injectMessage({
      text: `/workspace ${wsA}`,
      chatId: "test-chat-A",
    });
    channel.clearReplies();

    // Chat B uses workspace B
    await channel.injectMessage({
      text: `/workspace ${wsB}`,
      chatId: "test-chat-B",
    });
    channel.clearReplies();

    // Chat A: remember number 100
    await channel.injectMessage({
      text: "remember this number: 100. respond with just: ok",
      chatId: "test-chat-A",
    });

    // Chat B: remember number 200
    await channel.injectMessage({
      text: "remember this number: 200. respond with just: ok",
      chatId: "test-chat-B",
    });

    channel.clearReplies();

    // Chat A: recall — should know 100
    await channel.injectMessage({
      text: "what number did I tell you to remember? respond with just the number, nothing else.",
      chatId: "test-chat-A",
    });

    const repliesA = channel.getReplies().filter((r) => r.chatId === "test-chat-A");
    expect(repliesA.length).toBeGreaterThanOrEqual(1);
    const lastA = repliesA[repliesA.length - 1];
    expect(lastA.content).toContain("100");

    channel.clearReplies();

    // Chat B: recall — should know 200
    await channel.injectMessage({
      text: "what number did I tell you to remember? respond with just the number, nothing else.",
      chatId: "test-chat-B",
    });

    const repliesB = channel.getReplies().filter((r) => r.chatId === "test-chat-B");
    expect(repliesB.length).toBeGreaterThanOrEqual(1);
    const lastB = repliesB[repliesB.length - 1];
    expect(lastB.content).toContain("200");
  }, 180000);

  it("/new command creates fresh session", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    // Send /new
    await channel.injectMessage({
      text: "/new",
      chatId: "test-chat-new",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("New session created");
    expect(reply.content).toContain("Session:");
  }, 30000);

  it("/workspace shows current workspace", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    await channel.injectMessage({
      text: "/workspace",
      chatId: "test-chat-ws",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("Current workspace:");
    expect(reply.content).toContain(tempDir);
  }, 30000);

  it("/workspace <path> switches workspace", async () => {
    const newWs = path.join(tempDir, "subproject");
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel]);
    await daemon.start();

    await channel.injectMessage({
      text: `/workspace ${newWs}`,
      chatId: "test-chat-switch",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("Workspace switched");
    expect(reply.content).toContain(newWs);

    // Verify directory was created
    expect(fs.existsSync(newWs)).toBe(true);
  }, 30000);
});
