import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
}

export function sessionKey(chatId: string, workspace: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(chatId + ":" + workspace)
    .digest("hex");
  return hash.slice(0, 16);
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
  const files = fs.readdirSync(paths.sessionsDir).filter((f) => f.endsWith(".json") && !f.startsWith("chat_setting_"));
  const results: Array<{ key: string; meta: SessionMeta }> = [];
  for (const file of files) {
    const key = file.replace(".json", "");
    const meta = loadSession(key);
    if (meta) results.push({ key, meta });
  }
  return results;
}
