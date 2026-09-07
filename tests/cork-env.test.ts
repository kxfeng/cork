import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ~/.cork/env is cork's way of handing a variable to every claude it starts —
 * the service manager (launchd/systemd) does not read the user's shell rc
 * files, so an export there never reaches a pane.
 *
 * It has to go on the tmux SERVER, because a pane is forked by the server and
 * not by the `tmux new-session` client: the client's own environment reaches a
 * pane only through tmux's `update-environment` whitelist (DISPLAY, KRB5CCNAME,
 * SSH_*). Passing it to new-session used to work by accident — back then the
 * server had no `exit-empty off` and died whenever it was empty, so every
 * new-session was itself the call that forked the server. Adding an explicit
 * start-server moved that fork away and quietly turned the injection into a
 * no-op, which nothing caught. Hence these tests.
 *
 * It also must NOT be spliced into the pane's command line the way the locale
 * and CLAUDE_AUTOCOMPACT_PCT_OVERRIDE are: a command line is world-readable
 * through /proc/<pid>/cmdline, and this file is mode 600 precisely because it
 * holds things like proxy credentials.
 */

const { execCalls } = vi.hoisted(() => ({
  execCalls: [] as { cmd: string; opts?: { env?: NodeJS.ProcessEnv } }[],
}));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string, opts?: { env?: NodeJS.ProcessEnv }) => {
    execCalls.push({ cmd: String(cmd), opts });
    return "";
  },
}));

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-env-"));
  process.env.CORK_DIR = dir;
  execCalls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeEnvFile(content: string): void {
  fs.writeFileSync(path.join(dir, "env"), content);
}

/** The environment `start-server` would be forked with. */
async function serverEnv(): Promise<NodeJS.ProcessEnv> {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { ensureCorkTmuxServer } = await import("../src/session/tmux.js");
  ensureCorkTmuxServer();
  const call = execCalls.find((c) => c.cmd.includes("start-server"));
  expect(call).toBeDefined();
  return call!.opts?.env ?? {};
}

describe("~/.cork/env", () => {
  it("reaches the tmux server every pane is forked from", async () => {
    writeEnvFile("HTTPS_PROXY=http://proxy.example:8080\n");
    expect((await serverEnv()).HTTPS_PROXY).toBe("http://proxy.example:8080");
  });

  it("wins over the daemon's own environment", async () => {
    // A user who sets LANG in the file means it, so the locale fallback that
    // shares this env must not overwrite them.
    writeEnvFile("LANG=ja_JP.UTF-8\n");
    expect((await serverEnv()).LANG).toBe("ja_JP.UTF-8");
  });

  it("still sets a locale when the file does not exist", async () => {
    const env = await serverEnv();
    expect(env.LANG).toBeTruthy();
    expect(env.LC_CTYPE).toBeTruthy();
  });

  it("is not spliced into any command line", async () => {
    // /proc/<pid>/cmdline is world-readable; the file is not.
    writeEnvFile("HTTPS_PROXY=http://user:secret@proxy.example:8080\n");
    await serverEnv();
    for (const { cmd } of execCalls) expect(cmd).not.toContain("secret");
  });
});
