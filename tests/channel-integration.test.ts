import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CorkDaemon as CorkDaemonType } from "../src/daemon/daemon.js";
import type { TestChannel as TestChannelType } from "../src/channels/test/index.js";
import type { CorkConfig } from "../src/config/schema.js";

/**
 * End-to-end integration test driving the REAL production chain — only Lark is
 * swapped for TestChannel; everything else is production code:
 *
 *   TestChannel.injectMessage → MessageRouter → SessionManager.startSession
 *     → real claude in tmux (-L cork) → channel-mcp → UDS
 *     → daemon.handleReply → TestChannel.sendReply
 *
 * This exercises the production readiness gating, dev-channel dialog handling,
 * Stop hook and reply round-trip — unlike the old hand-rolled harness that
 * reimplemented (a weaker version of) all of it and was flaky as a result.
 *
 * Isolation — keeps the user's real claude install fully functional (login,
 * onboarding, install path all live under the real HOME) while making sure the
 * test daemon can't touch the running production daemon:
 *   - CORK_DIR        → temp dir ⇒ mcp-config / claude-settings / socket /
 *                       sessions all isolated; real ~/.cork is never written.
 *   - CORK_TMUX_LABEL → cork-test-<pid> ⇒ the daemon's tmux server is a
 *                       separate one from production's `-L cork`, so this
 *                       daemon's kill-server can't reap the real sessions.
 *   - workspace       → the cork repo root, which the real claude already
 *                       trusts, so no first-run trust dialog blocks startup.
 *
 * The daemon is loaded from built dist so the spawned claude resolves the real
 * channel-mcp/server.js + hooks/stop-hook.js (paths are relative to the
 * daemon's own module dir).
 */

const repoRoot = path.resolve(".");
const tmpRoot = path.join(os.tmpdir(), `cork-e2e-${process.pid}`);
const corkDir = path.join(tmpRoot, "cork");

const TMUX_LABEL = `cork-test-${process.pid}`;
let savedCorkDir: string | undefined;
let savedTmuxLabel: string | undefined;
let CorkDaemon: typeof CorkDaemonType;
let TestChannel: typeof TestChannelType;

function makeConfig(): CorkConfig {
  return {
    defaultWorkspace: repoRoot,
    claude: { permissionMode: "bypassPermissions", extraArgs: [] },
    channels: {},
  };
}

const CHAT_ID = "e2e-chat";

describe("Cork E2E (real claude via the production daemon)", () => {
  let channel: TestChannelType;
  let daemon: CorkDaemonType;

  beforeAll(async () => {
    // Build dist so the spawned claude loads the real channel-mcp + stop-hook.
    execSync("npx tsc", { cwd: repoRoot, stdio: "pipe" });
    const distChannelMcp = path.join(repoRoot, "dist/channel-mcp/server.js");
    if (!fs.existsSync(distChannelMcp)) {
      throw new Error(`dist channel-mcp not found at ${distChannelMcp}`);
    }

    // Set CORK_DIR BEFORE importing dist (config/paths.js reads it at import
    // time) to isolate everything cork writes. CORK_TMUX_LABEL gives this
    // daemon its own tmux server, distinct from production's `-L cork`.
    savedCorkDir = process.env.CORK_DIR;
    savedTmuxLabel = process.env.CORK_TMUX_LABEL;
    fs.mkdirSync(corkDir, { recursive: true });
    process.env.CORK_DIR = corkDir;
    process.env.CORK_TMUX_LABEL = TMUX_LABEL;

    ({ CorkDaemon } = await import(
      pathToFileURL(path.join(repoRoot, "dist/daemon/daemon.js")).href
    ));
    ({ TestChannel } = await import(
      pathToFileURL(path.join(repoRoot, "dist/channels/test/index.js")).href
    ));

    channel = new TestChannel();
    daemon = new CorkDaemon(makeConfig(), [channel]);
    await daemon.start();
    // No warm-up: the first assertion's message IS the cold-start first
    // message, exactly like production (send → spawn → deliver when ready →
    // reply). This is what we want to exercise.
  }, 120_000);

  afterAll(async () => {
    try {
      await daemon?.stop();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      if (savedCorkDir === undefined) delete process.env.CORK_DIR;
      else process.env.CORK_DIR = savedCorkDir;
      if (savedTmuxLabel === undefined) delete process.env.CORK_TMUX_LABEL;
      else process.env.CORK_TMUX_LABEL = savedTmuxLabel;
    }
  }, 30_000);

  it("round-trips a reply from a normal message", async () => {
    channel.clearReplies();
    const replyP = channel.waitForReply(90_000);
    await channel.injectMessage({
      text: "Reply with exactly the word: pong",
      chatId: CHAT_ID,
    });
    const reply = await replyP;
    expect(reply.content.toLowerCase()).toContain("pong");
  }, 100_000);

  it("keeps context across turns in the same session", async () => {
    channel.clearReplies();

    let replyP = channel.waitForReply(90_000);
    await channel.injectMessage({
      text: "Remember this number: 42. Reply with just: ok",
      chatId: CHAT_ID,
    });
    await replyP;

    replyP = channel.waitForReply(90_000);
    await channel.injectMessage({
      text: "What number did I tell you? Reply with just the number.",
      chatId: CHAT_ID,
    });
    const reply = await replyP;
    expect(reply.content).toContain("42");
  }, 100_000);
});
