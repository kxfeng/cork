export interface CorkConfig {
  defaultWorkspace: string;
  claude: ClaudeConfig;
  channels: ChannelsConfig;
}

export interface ClaudeConfig {
  permissionMode: "bypassPermissions" | "default";
  extraArgs: string[];
}

export interface ChannelsConfig {
  lark?: LarkChannelConfig;
  telegram?: TelegramChannelConfig;
}

export interface LarkChannelConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  owners: string[];
  ackEmoji: string;
  idleTimeoutMin: number;
}

export interface TelegramChannelConfig {
  /** BotFather token. */
  token: string;
  /** Allowlisted Telegram numeric user IDs (strings). Empty = nobody paired yet. */
  owners: string[];
  /** What to do with a message from a sender not in `owners`:
   * - "echo": reply once with their own id + how to get allowlisted (onboarding).
   * - "drop": silently ignore (lock-down, set after onboarding). */
  unknownSender: "echo" | "drop";
  /** Emoji reacted on receipt as an ack. Must be in Telegram's fixed whitelist
   * (👀 🔥 👍 …). Empty string disables the ack reaction. */
  ackReaction: string;
}

export const DEFAULT_CONFIG: CorkConfig = {
  defaultWorkspace: "~/Workspace",
  claude: {
    permissionMode: "bypassPermissions",
    extraArgs: [],
  },
  channels: {},
};
