import {
  loadSession,
  saveSession,
  sessionKey,
  type SessionMeta,
} from "../../session/store.js";

export interface ChatSettings {
  mentionRequired: boolean;
}

const cache = new Map<string, ChatSettings>();

function getSessionKey(chatId: string): string {
  return sessionKey("lark", chatId);
}

function defaultSettings(): ChatSettings {
  return { mentionRequired: true };
}

export function getChatSettings(chatId: string): ChatSettings {
  const cached = cache.get(chatId);
  if (cached) return cached;

  const key = getSessionKey(chatId);
  const meta = loadSession(key);
  if (meta) {
    const settings: ChatSettings = {
      mentionRequired: meta.mentionRequired ?? true,
    };
    cache.set(chatId, settings);
    return settings;
  }

  const defaults = defaultSettings();
  cache.set(chatId, defaults);
  return defaults;
}

export function updateChatSettings(chatId: string, update: Partial<ChatSettings>): void {
  const current = getChatSettings(chatId);
  const updated = { ...current, ...update };
  cache.set(chatId, updated);

  const key = getSessionKey(chatId);
  const meta = loadSession(key);
  if (meta) {
    meta.mentionRequired = updated.mentionRequired;
    saveSession(key, meta);
  }
}
