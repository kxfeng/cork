import fs from "node:fs";
import path from "node:path";
import * as jsonc from "jsonc-parser";
import { paths } from "./paths.js";
import { type CorkConfig, DEFAULT_CONFIG } from "./schema.js";

export function ensureDirs(): void {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
}

export function loadConfig(): CorkConfig {
  const parsed = loadRawConfig();
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    claude: { ...DEFAULT_CONFIG.claude, ...parsed.claude },
    channels: { ...DEFAULT_CONFIG.channels, ...parsed.channels },
  };
}

/**
 * The config exactly as written on disk, with no defaults merged in — the only
 * way to tell "the user never mentioned this key" from "the user set it to the
 * value that happens to be our default". Used to decide what to seed on first run.
 */
export function loadRawConfig(): Partial<CorkConfig> {
  if (!fs.existsSync(paths.configFile)) return {};
  const raw = fs.readFileSync(paths.configFile, "utf-8");
  return (jsonc.parse(raw) ?? {}) as Partial<CorkConfig>;
}

export function saveConfig(config: CorkConfig): void {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  const content = JSON.stringify(config, null, 2);
  // The config holds channel secrets — the Lark app secret and the Telegram bot
  // token — so it must never be group- or world-readable. `mode` is only honoured
  // when the file is created, so chmod unconditionally: that also repairs a config
  // written before this was enforced.
  fs.writeFileSync(paths.configFile, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(paths.configFile, 0o600);
}

export function resolveWorkspacePath(workspace: string): string {
  if (workspace.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, workspace.slice(2));
  }
  return path.resolve(workspace);
}
