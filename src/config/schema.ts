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
  /**
   * Compact at this percentage of the context window, for every session cork
   * starts. Passed to claude as CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, whose
   * threshold is `min(floor(window * pct/100), window - 13000)` — an integer
   * percentage (75, not 0.75), evaluated against whatever window is in effect,
   * so switching model mid-session recomputes it without cork's help. (The CLI
   * flag `--autocompact` takes a fixed token count instead, which is exactly
   * what a session that can change model must not be pinned to.)
   *
   * Claude Code compacts on its own at `window - 13000` regardless; this only
   * moves it earlier, to leave room for an autopilot run to record its state before
   * the summary happens. Out of range (or <= 0) means "don't set it", which is
   * also what happens if a future claude drops the variable.
   */
  autoCompactPercent?: number;
  /**
   * Override for the context window cork measures an autopilot run against when
   * deciding it is close enough to compaction to be told to write its state
   * down.
   *
   * Normally unset: the window is read off the model id the transcript records
   * on every assistant row, so it follows a model switched mid-task. Set this
   * only for a model cork does not know, and only knowing that it moves one
   * advisory message and nothing else — claude decides when to compact.
   */
  contextWindow?: number;
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
    autoCompactPercent: 75,
  },
  channels: {},
  web: { port: 6780 },
};
