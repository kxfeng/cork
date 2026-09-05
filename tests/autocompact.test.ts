import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every pane cork starts is told to compact early, so a long-running session has
 * room to write down what it is doing before the summary happens.
 *
 * This goes in as CLAUDE_AUTOCOMPACT_PCT_OVERRIDE rather than as the
 * `--autocompact <tokens>` flag: the variable is an integer percentage evaluated
 * against whatever context window is in effect, so a session that switches model
 * recomputes its own threshold, while the flag would pin it to a token count
 * that becomes wrong the moment the model changes.
 *
 * Claude Code accepts the variable only in (0, 100]. Passing a value outside
 * that does nothing — silently — so cork drops it here instead, and says so in
 * the log.
 */
const WS = "/tmp/cork-autocompact-ws";

// spawnPane assembles a shell command and hands it to execSync. Mock the module
// (an ESM import binding cannot be spied on after the fact) and keep the
// commands instead of running them.
const { execCalls } = vi.hoisted(() => ({ execCalls: [] as string[] }));
vi.mock("node:child_process", () => ({
  execSync: (cmd: string) => {
    execCalls.push(String(cmd));
    return "";
  },
}));

let dir: string;

async function makeManager(autoCompactPercent?: number) {
  vi.resetModules(); // paths.ts reads CORK_DIR at import time
  const { SessionManager } = await import("../src/session/manager.js");
  return new SessionManager({
    defaultWorkspace: WS,
    claude: { permissionMode: "default", extraArgs: [], autoCompactPercent },
    channels: {},
  } as never) as any;
}

/** The `tmux new-session` command spawnPane would run. */
function paneCommand(mgr: any, meta: Record<string, unknown>): string {
  execCalls.length = 0;
  mgr.spawnPane("sess-key", meta, ["--session-id", "x"]);
  return execCalls.find((c) => c.includes("new-session")) ?? "";
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-autocompact-"));
  process.env.CORK_DIR = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CORK_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

const META = { workspace: WS, channel: "lark" };

describe("auto-compact percentage", () => {
  it("puts the configured percentage in the pane's environment", async () => {
    const mgr = await makeManager(75);
    expect(paneCommand(mgr, META)).toContain(
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='75'"
    );
  });

  it("passes an integer, not a fraction", async () => {
    // 0.75 would be read as a percentage of 0.75% and compact almost at once.
    const mgr = await makeManager(75);
    const cmd = paneCommand(mgr, META);
    expect(cmd).not.toContain("0.75");
  });

  it("floors a fractional percentage rather than passing it through", async () => {
    const mgr = await makeManager(75.6);
    expect(paneCommand(mgr, META)).toContain(
      "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE='75'"
    );
  });

  it("sets nothing when the config says nothing", async () => {
    const mgr = await makeManager(undefined);
    expect(paneCommand(mgr, META)).not.toContain("AUTOCOMPACT");
  });

  it("drops a value claude would ignore instead of setting it", async () => {
    for (const bad of [0, -5, 101, Number.NaN]) {
      const mgr = await makeManager(bad);
      expect(paneCommand(mgr, META)).not.toContain("AUTOCOMPACT");
    }
  });

  it("still carries the session key and channel it was already passing", async () => {
    // The env line is assembled by string concatenation; an autocompact bug
    // there would just as easily drop one of these.
    const mgr = await makeManager(75);
    const cmd = paneCommand(mgr, META);
    expect(cmd).toContain("CORK_SESSION_KEY='sess-key'");
    expect(cmd).toContain("CORK_CHANNEL_NAME='lark'");
  });
});

describe("default config", () => {
  it("ships 75 so every session gets it without being configured", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/schema.js");
    expect(DEFAULT_CONFIG.claude.autoCompactPercent).toBe(75);
  });

  it("merges into a config file that predates the key", async () => {
    const { DEFAULT_CONFIG } = await import("../src/config/schema.js");
    const merged = {
      ...DEFAULT_CONFIG,
      claude: {
        ...DEFAULT_CONFIG.claude,
        ...{ permissionMode: "default" as const, extraArgs: [] },
      },
    };
    expect(merged.claude.autoCompactPercent).toBe(75);
  });
});
