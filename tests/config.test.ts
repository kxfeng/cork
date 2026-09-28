import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The config holds channel secrets (Lark app secret, Telegram bot token), so it
 * must never be readable by group or others. Uses CORK_DIR to stay well away
 * from the user's real ~/.cork.
 */
describe("saveConfig permissions", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-config-test-"));
    process.env.CORK_DIR = dir;
    vi.resetModules(); // paths.ts reads CORK_DIR at import time
  });

  afterEach(() => {
    delete process.env.CORK_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function save(): Promise<string> {
    const { saveConfig } = await import("../src/config/loader.js");
    const { DEFAULT_CONFIG } = await import("../src/config/schema.js");
    saveConfig({ ...DEFAULT_CONFIG });
    return path.join(dir, "config.json");
  }

  const mode = (f: string) => fs.statSync(f).mode & 0o777;

  it("creates the config 0600", async () => {
    const file = await save();
    expect(mode(file)).toBe(0o600);
  });

  it("repairs an existing world-readable config", async () => {
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    expect(mode(file)).toBe(0o644);

    await save();
    expect(mode(file)).toBe(0o600);
  });
});

/**
 * The config used to be config.jsonc, and people wrote comments in it. It moves
 * to config.json the first time anything loads the config.
 */
describe("moving config.jsonc to config.json", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-config-move-"));
    process.env.CORK_DIR = dir;
    vi.resetModules();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    delete process.env.CORK_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const at = (f: string) => path.join(dir, f);
  const LEGACY = `{
  // the app
  "defaultWorkspace": "~/Code",
  "channels": {
    "lark": { "appId": "cli_x", "owners": ["ou_1"], }, /* trailing comma */
  },
}
`;

  it("reads comments and trailing commas, writes plain JSON 0600, keeps the old file", async () => {
    fs.writeFileSync(at("config.jsonc"), LEGACY);
    const { loadConfig } = await import("../src/config/loader.js");
    const cfg = loadConfig();
    expect(cfg.defaultWorkspace).toBe("~/Code");
    expect(cfg.channels.lark?.owners).toEqual(["ou_1"]);
    expect(JSON.parse(fs.readFileSync(at("config.json"), "utf-8"))).toEqual({
      defaultWorkspace: "~/Code",
      channels: { lark: { appId: "cli_x", owners: ["ou_1"] } },
    });
    expect(fs.statSync(at("config.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(at("config.jsonc"))).toBe(false);
    expect(fs.readFileSync(at("config.jsonc.bak"), "utf-8")).toBe(LEGACY);
  });

  it("does not overwrite an earlier backup", async () => {
    fs.writeFileSync(at("config.jsonc"), LEGACY);
    fs.writeFileSync(at("config.jsonc.bak"), "older");
    const { loadConfig } = await import("../src/config/loader.js");
    loadConfig();
    expect(fs.readFileSync(at("config.jsonc.bak"), "utf-8")).toBe("older");
    const moved = fs.readdirSync(dir).filter((f) => f.startsWith("config.jsonc.bak-"));
    expect(moved).toHaveLength(1);
  });

  it("leaves both alone once config.json exists", async () => {
    fs.writeFileSync(at("config.json"), JSON.stringify({ defaultWorkspace: "~/New" }));
    fs.writeFileSync(at("config.jsonc"), LEGACY);
    const { loadConfig } = await import("../src/config/loader.js");
    expect(loadConfig().defaultWorkspace).toBe("~/New");
    expect(fs.readFileSync(at("config.jsonc"), "utf-8")).toBe(LEGACY);
  });

  it("moves nothing it cannot read, and says which file", async () => {
    fs.writeFileSync(at("config.jsonc"), '{ "a": ');
    const { loadConfig } = await import("../src/config/loader.js");
    expect(() => loadConfig()).toThrow(/config\.jsonc could not be read/);
    expect(fs.existsSync(at("config.json"))).toBe(false);
    expect(fs.existsSync(at("config.jsonc"))).toBe(true);
  });

  it("names the file when config.json is not valid JSON", async () => {
    fs.writeFileSync(at("config.json"), '{ "a": 1, }');
    const { loadConfig } = await import("../src/config/loader.js");
    expect(() => loadConfig()).toThrow(/config\.json is not valid JSON/);
  });
});

describe("saveConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cork-config-save-"));
    process.env.CORK_DIR = dir;
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.CORK_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips what is on disk without adding cork's defaults", async () => {
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ timezone: "Asia/Singapore" }));
    const { loadRawConfig, saveConfig } = await import("../src/config/loader.js");
    saveConfig({ ...loadRawConfig(), web: { port: 7000 } } as never);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"))).toEqual({
      timezone: "Asia/Singapore",
      web: { port: 7000 },
    });
  });
});
