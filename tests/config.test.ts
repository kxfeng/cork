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
    return path.join(dir, "config.jsonc");
  }

  const mode = (f: string) => fs.statSync(f).mode & 0o777;

  it("creates the config 0600", async () => {
    const file = await save();
    expect(mode(file)).toBe(0o600);
  });

  it("repairs an existing world-readable config", async () => {
    const file = path.join(dir, "config.jsonc");
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    expect(mode(file)).toBe(0o644);

    await save();
    expect(mode(file)).toBe(0o600);
  });
});
