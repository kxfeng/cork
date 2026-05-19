import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect every cork path into an isolated temp dir before any source
// module loads. daemon.start() writes mcp-config.json / claude-settings.json
// via writeMcpConfig/writeClaudeSettings — without this the suite would
// overwrite the real ~/.cork. vi.hoisted lets the mock factory use the path.
const corkHome = vi.hoisted(
  () =>
    `${(process.env.TMPDIR || "/tmp").replace(/\/+$/, "")}/cork-test-home-${process.pid}`
);
vi.mock("../src/config/paths.js", () => ({
  paths: {
    corkDir: corkHome,
    configFile: `${corkHome}/config.jsonc`,
    envFile: `${corkHome}/env`,
    sessionsDir: `${corkHome}/sessions`,
    socketPath: `${corkHome}/cork.sock`,
    logsDir: `${corkHome}/logs`,
    logFile: `${corkHome}/logs/cork.log`,
    stdoutLog: `${corkHome}/logs/stdout.log`,
    stderrLog: `${corkHome}/logs/stderr.log`,
    launchdPlist: `${corkHome}/com.cork.daemon.plist`,
  },
}));

import { TestChannel } from "../src/channels/test/index.js";
import { CorkDaemon } from "../src/daemon/daemon.js";
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

describe("Cork Integration Tests (commands)", () => {
  let tempDir: string;
  let channel: TestChannel;
  let daemon: CorkDaemon;
  let sockPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    sockPath = path.join(tempDir, "test.sock");
    channel = new TestChannel();
  });

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
    }
    // Wipe the per-test workspace and the isolated cork home. The real
    // ~/.cork is mocked away, so nothing here can reach it.
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(corkHome, { recursive: true, force: true });
  });

  it("/new command creates fresh session", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel], sockPath);
    await daemon.start();

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
    daemon = new CorkDaemon(config, [channel], sockPath);
    await daemon.start();

    // First create a session
    await channel.injectMessage({
      text: "/new",
      chatId: "test-chat-ws",
    });
    channel.clearReplies();

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

  it("/new <path> creates session with custom workspace", async () => {
    const newWs = path.join(tempDir, "subproject");
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel], sockPath);
    await daemon.start();

    await channel.injectMessage({
      text: `/new ${newWs}`,
      chatId: "test-chat-newws",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("New session created");
    expect(reply.content).toContain(newWs);

    // Verify directory was created
    expect(fs.existsSync(newWs)).toBe(true);
  }, 30000);

  it("/status shows session info", async () => {
    const config = makeConfig(tempDir);
    daemon = new CorkDaemon(config, [channel], sockPath);
    await daemon.start();

    // Create a session first
    await channel.injectMessage({
      text: "/new",
      chatId: "test-chat-status",
    });
    channel.clearReplies();

    await channel.injectMessage({
      text: "/status",
      chatId: "test-chat-status",
    });

    const replies = channel.getFinalReplies();
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("Session Status");
    expect(reply.content).toContain("Workspace:");
    expect(reply.content).toContain("Claude context:");
  }, 30000);
});
