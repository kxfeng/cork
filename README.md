# Cork

> Bridge Lark/Feishu chats to Claude Code, one persistent session per chat.

Cork is a macOS daemon that turns a Lark/Feishu bot into a remote front‑end for [Claude Code](https://www.anthropic.com/claude-code). Every chat (DM or group) gets its own long‑lived `claude` process running in a `tmux` session, so the conversation survives restarts and you can attach a real terminal whenever you want to look over its shoulder.

```
You ── Lark/Feishu ──▶ cork daemon ──▶ tmux ──▶ claude code (per chat)
```

## Why

- **Pair‑program from your phone.** Reply to Claude in Lark, watch it work in `tmux` from any machine.
- **Per‑chat memory.** Each chat is a distinct Claude session; group chats stay separate from DMs.
- **Real terminal.** Attach with `tmux attach -t cork_lark:<chatId>` to type by hand or read the raw output.
- **Workspace‑aware.** Each chat can be pointed at a different repo / project directory.

## Status

Early/personal use. Cork relies on the experimental Claude Code [channel](https://docs.claude.com/en/docs/claude-code/channels) protocol via `--dangerously-load-development-channels`, so the YES‑prompt is auto‑dismissed at startup. This may break when channels graduate out of research preview.

Today only the Lark/Feishu adapter ships. The session/router layer is channel‑agnostic — adding Slack/Telegram/etc. is mostly an adapter job.

## Requirements

- **macOS** (the daemon is wired to `launchd`; Linux works in foreground mode but isn't a target)
- **Node.js 22+**
- **`tmux`** on `PATH`
- **`claude`** CLI on `PATH` (Claude Code installed and signed in)
- A Feishu (`feishu.cn`) or Lark (`larksuite.com`) account that can register a personal bot

## Install

```bash
pnpm add -g --allow-build=cork github:kxfeng/cork
```

`pnpm` clones the repo, runs the TypeScript build, and links the `cork` binary onto your `PATH`. The `--allow-build=cork` flag is required because pnpm 10+ blocks lifecycle scripts on git‑hosted packages by default — without it the install fails with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`.

To upgrade, re‑run the same command — pnpm refetches the latest `main`.

## Quick start

```bash
cork setup        # interactive: QR‑code login + Lark bot creation
cork start        # background daemon (registers a launchd agent)
cork status       # check daemon + active sessions
```

Then `@‑mention` your bot in Lark, send a message, and watch the bot reply with whatever Claude says back.

To watch what Claude is actually doing in a given chat:

```bash
tmux ls
tmux attach -t cork_lark:<chatId>
# detach with: Ctrl+b d
```

## Commands

### CLI

| Command           | What it does                                                  |
| ----------------- | ------------------------------------------------------------- |
| `cork setup`      | Configure the default workspace + run Lark QR login flow      |
| `cork start`      | Start the daemon under `launchd` (auto‑restarts, runs at login) |
| `cork start --foreground` | Run in the current shell (for debugging)              |
| `cork stop`       | Stop the daemon                                               |
| `cork restart`    | `stop` + `start`                                              |
| `cork status`     | Show daemon state, socket, and live sessions                  |

### In‑chat slash commands

Send these from Lark — they are handled by the daemon, not by Claude:

| Command                | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `/status`              | Show this chat's session state (workspace, last activity, …)  |
| `/new`                 | Throw away the current Claude session and start a fresh one   |
| `/workspace <path>`    | Re‑point this chat at a different working directory           |
| `/mention-on` / `/mention-off` | Toggle whether `@bot` is required for the bot to react in groups |

## Configuration

All state lives under `~/.cork/`:

```
~/.cork/
├── config.jsonc        # main config (created by `cork setup`)
├── env                 # extra env vars exported to every claude session (one KEY=VALUE per line)
├── mcp-config.json     # auto‑written; points claude at the cork channel MCP
├── cork.sock           # UDS the channel MCP connects to
├── sessions/           # per‑chat metadata
└── logs/               # cork.log + launchd stdout/stderr
```

`~/.cork/env` is the easy way to pass things like `ANTHROPIC_MODEL` or proxy settings to every Claude session — `launchd` doesn't read your shell rc files, so exports there won't reach Claude otherwise.

`config.jsonc` (excerpt):

```jsonc
{
  "defaultWorkspace": "~/Workspace",
  "claude": {
    "permissionMode": "bypassPermissions",   // pass --dangerously-skip-permissions
    "extraArgs": []                          // any extra flags forwarded to claude
  },
  "channels": {
    "lark": {
      "appId": "...",
      "appSecret": "...",
      "domain": "feishu",                     // or "lark"
      "owners": ["ou_..."],                   // open_ids allowed to use the bot
      "ackEmoji": "👀",
      "streamingIntervalMs": 1500,
      "idleTimeoutMin": 30
    }
  }
}
```

## How it works

1. `cork start` launches a daemon that opens a Unix domain socket at `~/.cork/cork.sock` and connects to Lark via WebSocket.
2. When a Lark message arrives, cork picks the matching session (one per `chatId`).
3. If no Claude is running for that chat, cork starts one inside a fresh `tmux` window with `claude --mcp-config ~/.cork/mcp-config.json --dangerously-load-development-channels server:cork-channel`.
4. Claude loads the bundled `cork-channel-mcp` MCP server, which connects back to cork's UDS and registers itself.
5. From then on: Lark → cork → UDS → channel MCP → Claude (and back the other way for replies).

The full design — message flow, dedup, queueing, permission relay — is in [DESIGN.md](./DESIGN.md).

## Troubleshooting

**`cork status` says daemon is running but no sessions appear.**
Check `~/.cork/logs/cork.log` for Lark WS errors. Most often: app secret rotated, or the bot hasn't been added to the chat yet.

**Bot stays silent in group chats.**
Group chats require `@‑mention` by default. Either mention the bot, or send `/mention-off` in that group.

**Claude never connects (`session starting timeout` in logs).**
Attach the tmux session and look at the screen — usually a stuck dialog cork's regex didn't catch. File an issue with the `tmux capture-pane -p` output.

**Stuck `tmux` sessions after a crash.**
`tmux kill-server` or `tmux kill-session -t cork_<chatId>`; cork will re‑create them on next message.

## Development

```bash
git clone https://github.com/kxfeng/cork.git
cd cork
pnpm install
pnpm run dev            # tsx, no rebuild needed
pnpm run test           # vitest
pnpm run build          # tsc → dist/
pnpm link --global      # use your local checkout as the global `cork`
```

PRs welcome. Two areas that especially need work:

- A second channel adapter (Slack / Telegram) to validate the abstraction.
- Linux `systemd` equivalent for the launchd integration.

## License

MIT
