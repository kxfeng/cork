import fs from "node:fs";
import path from "node:path";
import { paths } from "../../config/paths.js";

interface ChatSettings {
  mentionRequired: boolean;
}

const cache = new Map<string, ChatSettings>();

function settingsPath(chatId: string): string {
  return path.join(paths.sessionsDir, `chat_setting_lark_${chatId}.json`);
}

function defaultSettings(): ChatSettings {
  return { mentionRequired: true };
}

export function getChatSettings(chatId: string): ChatSettings {
  const cached = cache.get(chatId);
  if (cached) return cached;

  const filePath = settingsPath(chatId);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const settings = { ...defaultSettings(), ...data };
      cache.set(chatId, settings);
      return settings;
    } catch {
      // Corrupted file, use defaults
    }
  }

  const defaults = defaultSettings();
  cache.set(chatId, defaults);
  return defaults;
}

export function updateChatSettings(chatId: string, update: Partial<ChatSettings>): void {
  const current = getChatSettings(chatId);
  const updated = { ...current, ...update };
  cache.set(chatId, updated);

  fs.mkdirSync(paths.sessionsDir, { recursive: true });
  fs.writeFileSync(settingsPath(chatId), JSON.stringify(updated, null, 2), "utf-8");
}
