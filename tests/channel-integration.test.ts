import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UdsServer, type ReplyMessage } from "../src/daemon/uds-server.js";

/**
 * Integration test for the full Cork ↔ Channel MCP ↔ Claude Code chain.
 *
 * Setup:
 * 1. Cork side: start UDS server on a temp socket
 * 2. Launch Claude Code in a tmux session (provides real TTY for interactive mode)
 * 3. Channel MCP connects to UDS and registers
 * 4. Test sends messages through UDS → channel MCP → Claude Code
 * 5. Claude replies via reply tool → channel MCP → UDS → test collects reply
 */

const testDir = path.join(os.tmpdir(), `cork-channel-test-${process.pid}`);
const sockPath = path.join(testDir, "test.sock");
const workDir = path.join(testDir, "workspace");

// Path to the compiled channel MCP server
const channelServerPath = path.resolve("dist/channel-mcp/server.js");

const SESSION_KEY = "test_integration_session";
const TMUX_SESSION = `cork-test-${process.pid}`;

describe("Channel Integration (real Claude Code)", () => {
  let udsServer: UdsServer;
  let registered = false;
  let replies: ReplyMessage[] = [];

  beforeAll(async () => {
    // Build the project first
    const buildResult = await runCommand("npx", ["tsc"], { cwd: path.resolve(".") });
    if (buildResult.code !== 0) {
      throw new Error(`Build failed: ${buildResult.stderr}`);
    }

    // Verify the channel server was built
    if (!fs.existsSync(channelServerPath)) {
      throw new Error(`Channel server not found at ${channelServerPath}`);
    }

    // Create test directories
    fs.mkdirSync(workDir, { recursive: true });

    // 1. Start UDS server
    udsServer = new UdsServer(sockPath);
    await udsServer.start();

    udsServer.on("register", (key: string) => {
      if (key === SESSION_KEY) registered = true;
    });

    udsServer.on("reply", (msg: ReplyMessage) => {
      replies.push(msg);
    });

    // 2. Write MCP config to a temp file (session key is passed via env, not in config)
    const mcpConfigPath = path.join(testDir, "mcp-config.json");
    const mcpConfig = {
      mcpServers: {
        "cork-channel": {
          command: "node",
          args: [channelServerPath],
          env: {
            CORK_SOCKET: sockPath,
          },
        },
      },
    };
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

    // 3. Launch Claude Code inside a tmux session.
    // tmux provides a real PTY so Claude runs in interactive mode,
    // which is required for channels to work.
    // CORK_SESSION_KEY is passed via env var, inherited by Claude → MCP subprocess.
    const claudeCmd = [
      `CORK_SESSION_KEY='${SESSION_KEY}'`,
      "claude",
      "--verbose",
      "--dangerously-skip-permissions",
      "--mcp-config", mcpConfigPath,
      "--dangerously-load-development-channels", "server:cork-channel",
    ].join(" ");

    try {
      execSync(
        `tmux new-session -d -s ${TMUX_SESSION} -x 120 -y 40 "cd ${workDir} && ${claudeCmd}"`,
        { env: { ...process.env }, stdio: "pipe" }
      );
    } catch (err) {
      throw new Error(`Failed to start tmux session: ${(err as Error).message}`);
    }

    // 4. Accept the workspace trust dialog.
    // Claude shows a trust prompt for new workspaces even with --dangerously-skip-permissions.
    // Wait for the dialog to appear, then send Enter to accept the default "Yes, I trust".
    await new Promise((r) => setTimeout(r, 3000));
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`, { stdio: "pipe" });
    } catch {
      // Session may have already passed the dialog
    }

    // Also accept the development channel confirmation prompt
    await new Promise((r) => setTimeout(r, 2000));
    try {
      execSync(`tmux send-keys -t ${TMUX_SESSION} Enter`, { stdio: "pipe" });
    } catch {
      // May not need it
    }

    // 5. Wait for channel MCP to register via UDS
    await waitFor(() => registered, 40_000, "channel MCP registration");
  }, 60_000);

  afterAll(async () => {
    // Kill tmux session
    try {
      execSync(`tmux kill-session -t ${TMUX_SESSION}`, { stdio: "pipe" });
    } catch {
      // Session may already be dead
    }

    // Stop UDS server
    await udsServer?.stop();

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  }, 15_000);

  it("channel MCP registers on startup", () => {
    expect(registered).toBe(true);
    expect(udsServer.isConnected(SESSION_KEY)).toBe(true);
  });

  it("sends message to Claude and receives reply", async () => {
    replies = [];

    // Send a message through UDS → channel MCP → Claude Code
    udsServer.sendToChannel(SESSION_KEY, {
      type: "message",
      content: "Reply with exactly the word: pong",
      meta: { chatId: "test_chat", senderId: "test_user" },
    });

    // Wait for reply via UDS
    await waitFor(() => replies.length > 0, 90_000, "Claude reply");

    const reply = replies[replies.length - 1];
    expect(reply.type).toBe("reply");
    expect(reply.corkSessionKey).toBe(SESSION_KEY);
    expect(reply.content.toLowerCase()).toContain("pong");
  }, 120_000);

  it("handles multi-turn conversation", async () => {
    replies = [];

    // Turn 1: tell Claude a number
    udsServer.sendToChannel(SESSION_KEY, {
      type: "message",
      content: "Remember this number: 42. Reply with just: ok",
      meta: { chatId: "test_chat", senderId: "test_user" },
    });

    await waitFor(() => replies.length > 0, 90_000, "turn 1 reply");
    replies = [];

    // Turn 2: recall the number
    udsServer.sendToChannel(SESSION_KEY, {
      type: "message",
      content: "What number did I tell you? Reply with just the number.",
      meta: { chatId: "test_chat", senderId: "test_user" },
    });

    await waitFor(() => replies.length > 0, 90_000, "turn 2 reply");

    const reply = replies[replies.length - 1];
    expect(reply.content).toContain("42");
  }, 200_000);
});

// --- Helpers ---

function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (condition()) {
      resolve();
      return;
    }
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        clearTimeout(timer);
        resolve();
      }
    }, 500);
    const timer = setTimeout(() => {
      clearInterval(interval);
      reject(new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`));
    }, timeoutMs);
  });
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.on("exit", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
