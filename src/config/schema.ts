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
}

export interface LarkChannelConfig {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  owners: string[];
  ackEmoji: string;
  streamingIntervalMs: number;
  idleTimeoutMin: number;
}

export const DEFAULT_CONFIG: CorkConfig = {
  defaultWorkspace: "~/Workspace",
  claude: {
    permissionMode: "bypassPermissions",
    extraArgs: [],
  },
  channels: {},
};
