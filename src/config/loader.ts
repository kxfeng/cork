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
  if (!fs.existsSync(paths.configFile)) {
    return { ...DEFAULT_CONFIG };
  }
  const raw = fs.readFileSync(paths.configFile, "utf-8");
  const parsed = jsonc.parse(raw) as Partial<CorkConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    claude: { ...DEFAULT_CONFIG.claude, ...parsed.claude },
    channels: { ...DEFAULT_CONFIG.channels, ...parsed.channels },
  };
}

export function saveConfig(config: CorkConfig): void {
  fs.mkdirSync(path.dirname(paths.configFile), { recursive: true });
  const content = JSON.stringify(config, null, 2);
  fs.writeFileSync(paths.configFile, content, "utf-8");
}

export function resolveWorkspacePath(workspace: string): string {
  if (workspace.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    return path.resolve(home, workspace.slice(2));
  }
  return path.resolve(workspace);
}
