import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `cork restart` restarts and nothing else: only `cork start` writes the unit /
 * plist. The service manager does stop-and-start as one operation, so a restart
 * asked for from inside a pane it tears down still completes.
 */

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<object>()),
  execSync: (cmd: string) => {
    calls.push(String(cmd));
    if (cmd.startsWith("launchctl list")) return "{ PID = 1; }";
    return "";
  },
}));

let dir: string;
const realHome = process.env.HOME;
const realXdg = process.env.XDG_CONFIG_HOME;
const realPlatform = process.platform;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-restart-"));
  process.env.HOME = dir;
  process.env.XDG_CONFIG_HOME = path.join(dir, ".config");
  calls.length = 0;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  process.env.HOME = realHome;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  Object.defineProperty(process, "platform", { value: realPlatform });
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function load(platform: string) {
  Object.defineProperty(process, "platform", { value: platform });
  const { paths } = await import("../src/config/paths.js");
  const service = await import("../src/daemon/service.js");
  return { paths, service };
}

describe("on Linux", () => {
  it("restarts through systemctl and leaves the unit as it is", async () => {
    const { paths, service } = await load("linux");
    fs.mkdirSync(path.dirname(paths.systemdUnit), { recursive: true });
    fs.writeFileSync(paths.systemdUnit, "installed by cork start\n");
    service.restart();
    expect(calls).toContain("systemctl --user restart cork");
    expect(calls.some((c) => c.includes("daemon-reload"))).toBe(false);
    expect(fs.readFileSync(paths.systemdUnit, "utf-8")).toBe("installed by cork start\n");
    // It differs from what this cork would write, so the user is told how to refresh it.
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/cork stop && cork start/));
  });

  it("says nothing when the unit is current", async () => {
    const { paths, service } = await load("linux");
    fs.mkdirSync(path.dirname(paths.systemdUnit), { recursive: true });
    fs.writeFileSync(paths.systemdUnit, service.generateUnit());
    service.restart();
    expect(console.log).not.toHaveBeenCalled();
  });
});

describe("on macOS", () => {
  it("restarts through launchctl kickstart, without unloading or rewriting the plist", async () => {
    const { paths, service } = await load("darwin");
    fs.mkdirSync(path.dirname(paths.launchdPlist), { recursive: true });
    fs.writeFileSync(paths.launchdPlist, service.generatePlist());
    service.restart();
    expect(calls).toContain(`launchctl kickstart -k gui/${os.userInfo().uid}/com.cork.daemon 2>&1`);
    expect(calls.some((c) => c.includes("unload") || c.includes("launchctl load"))).toBe(false);
  });

  it("installs when there is no plist yet", async () => {
    const { paths, service } = await load("darwin");
    service.restart();
    expect(fs.existsSync(paths.launchdPlist)).toBe(true);
    expect(calls.some((c) => c.startsWith("launchctl load"))).toBe(true);
  });
});
