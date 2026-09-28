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
 * value that happens to be our default". Used to decide what to seed on first
 * run, and the thing to change and hand back to saveConfig.
 */
export function loadRawConfig(): Partial<CorkConfig> {
  migrateLegacyConfig();
  if (!fs.existsSync(paths.configFile)) return {};
  const raw = fs.readFileSync(paths.configFile, "utf-8");
  try {
    return (JSON.parse(raw) ?? {}) as Partial<CorkConfig>;
  } catch (err) {
    throw new Error(`${paths.configFile} is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Write the config. Takes what loadRawConfig returned, changed — not a
 * loadConfig result, whose defaults would all land in the file as if the user
 * had chosen them, and then stop following cork's defaults when those change.
 */
export function saveConfig(config: Partial<CorkConfig>): void {
  writeConfigFile(JSON.stringify(config, null, 2) + "\n");
}

function writeConfigFile(content: string): void {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  // The config holds channel secrets — the Lark app secret and the Telegram bot
  // token — so it must never be group- or world-readable. `mode` is only honoured
  // when the file is created, so chmod unconditionally: that also repairs a config
  // written before this was enforced.
  fs.writeFileSync(paths.configFile, content, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(paths.configFile, 0o600);
}

/**
 * The config used to be config.jsonc. Move it to config.json once, the first
 * time anything loads the config: read leniently, so comments and trailing
 * commas a user wrote do not stop the move, and keep the old file beside it as
 * config.jsonc.bak. Does nothing once config.json exists.
 */
function migrateLegacyConfig(): void {
  if (fs.existsSync(paths.configFile) || !fs.existsSync(paths.legacyConfigFile)) return;
  const errors: jsonc.ParseError[] = [];
  const parsed = jsonc.parse(fs.readFileSync(paths.legacyConfigFile, "utf-8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length) {
    const at = errors[0].offset;
    throw new Error(
      `${paths.legacyConfigFile} could not be read (${jsonc.printParseErrorCode(errors[0].error)} at offset ${at}), so it was not moved to ${paths.configFile}`
    );
  }
  writeConfigFile(JSON.stringify(parsed ?? {}, null, 2) + "\n");
  let bak = `${paths.legacyConfigFile}.bak`;
  if (fs.existsSync(bak)) bak = `${bak}-${Date.now()}`;
  fs.renameSync(paths.legacyConfigFile, bak);
  console.error(`cork: moved ${paths.legacyConfigFile} to ${paths.configFile} (old file kept as ${bak})`);
}

export function resolveWorkspacePath(workspace: string): string {
  if (workspace.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, workspace.slice(2));
  }
  return path.resolve(workspace);
}
