import fs from "node:fs";
import path from "node:path";
import { paths } from "../config/paths.js";

export interface SessionMeta {
  sessionId: string;
  chatId: string;
  chatType: "p2p" | "group";
  chatName: string;
  workspace: string;
  createdAt: string;
  lastActiveAt: string;
  lastMessagePreview: string;
  // Whether Claude Code session was ever successfully started with this sessionId
  claudeSessionStarted: boolean;
  // Chat settings (previously in separate chat_setting_ files)
  mentionRequired: boolean;
}

/**
 * Generate session key from channel and chat ID.
 * Format: {channelId}_{chatId}, e.g. "lark_oc_e21e11a61c56575e557f73370733c6de"
 */
export function sessionKey(channelId: string, chatId: string): string {
  return `${channelId}_${chatId}`;
}

export function loadSession(key: string): SessionMeta | null {
  const filePath = path.join(paths.sessionsDir, `${key}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionMeta;
}

export function saveSession(key: string, meta: SessionMeta): void {
  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  const filePath = path.join(paths.sessionsDir, `${key}.json`);
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2), "utf-8");
}

export function deleteSession(key: string): void {
  const filePath = path.join(paths.sessionsDir, `${key}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function listSessions(): Array<{ key: string; meta: SessionMeta }> {
  if (!fs.existsSync(paths.sessionsDir)) return [];
  const files = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith(".json"));
  const results: Array<{ key: string; meta: SessionMeta }> = [];
  for (const file of files) {
    const key = file.replace(".json", "");
    const meta = loadSession(key);
    if (meta) results.push({ key, meta });
  }
  return results;
}
