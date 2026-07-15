export interface CorkConfig {
  defaultWorkspace: string;
  claude: ClaudeConfig;
  channels: ChannelsConfig;
  web?: WebConfig;
}

/**
 * Browser terminal at http://127.0.0.1:<port>/ — the session list plus an
 * interactive xterm attached to each pane. On by default.
 *
 * Attaching to a pane is equivalent to a shell on this machine, and cork's panes
 * run Claude with permissions bypassed, so the token in ~/.cork/web-token (0600)
 * is ALWAYS required — binding loopback is not itself an authentication story.
 * Any reverse proxy (nginx, ngrok, cloudflared, ssh -R) can republish a loopback
 * port, and a proxied request can carry any headers it likes: `Host` is routinely
 * rewritten to 127.0.0.1, and a non-browser client can simply assert
 * `Origin: http://127.0.0.1:<port>`. Browser-provenance headers only constrain
 * real browsers; they cannot stand in for a secret.
 *
 * The token is accepted from ?token=… or from the cookie the server sets on the
 * first such request, so the URL only has to carry it once (see src/web/server.ts).
 */
export interface WebConfig {
  port: number;
  /** Bind address. Defaults to 127.0.0.1. */
  host?: string;
}

export interface ClaudeConfig {
  permissionMode: "bypassPermissions" | "default";
  extraArgs: string[];
}

export interface ChannelsConfig {
  lark?: LarkChannelConfig;
  telegram?: TelegramChannelConfig;
}

/** Shared across channels: turn one off without deleting its config. */
export interface ChannelToggle {
  /** Off when explicitly false. Absent ⇒ enabled, so existing configs are
   * unaffected and a freshly set-up channel works without adding the key. */
  enabled?: boolean;
}

/**
 * Whether a configured channel should run. Absent `enabled` means yes — do not
 * change this to `=== true`, or every existing config (none of which has the key)
 * would silently stop working.
 */
export function channelEnabled(c: ChannelToggle): boolean {
  return c.enabled !== false;
}

export interface LarkChannelConfig extends ChannelToggle {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  owners: string[];
  ackEmoji: string;
  idleTimeoutMin: number;
}

export interface TelegramChannelConfig extends ChannelToggle {
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
  web: { port: 6780 },
};
