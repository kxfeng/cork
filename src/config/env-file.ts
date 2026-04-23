import fs from "node:fs";
import { paths } from "./paths.js";
import { getLogger } from "../logger.js";

const logger = getLogger("env-file");

/**
 * Parse a dotenv-style file. Supported syntax:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='value with spaces'
 *   # comment
 *
 * No shell expansion or variable interpolation. Whitespace around the
 * key and around an unquoted value is trimmed.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/**
 * Load env vars from ~/.cork/env. Returns {} if the file does not exist.
 * Errors are logged and treated as empty (cork should not fail to start
 * because of a bad env file).
 */
export function loadCorkEnv(): Record<string, string> {
  const file = paths.envFile;
  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn("failed to read env file", { file, err });
    }
    return {};
  }
  const env = parseEnvFile(content);
  const keys = Object.keys(env);
  if (keys.length > 0) {
    logger.info("loaded env file", { file, keys });
  }
  return env;
}
