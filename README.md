# Cork

> Bridge Lark/Feishu chats to Claude Code, one persistent session per chat.

Cork is a macOS/Linux daemon that turns a Lark/Feishu bot into a remote front‑end for [Claude Code](https://www.anthropic.com/claude-code). Every chat (DM or group) gets its own long‑lived `claude` process running in a `tmux` session, so the conversation survives restarts and you can attach a real terminal whenever you want to look over its shoulder.

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

- **macOS or Linux** — the background daemon is managed by `launchd` on macOS and by the `systemd --user` instance on Linux (Ubuntu/Debian and any systemd distro). On Linux, run `loginctl enable-linger $USER` once so the daemon survives logout and starts at boot; without it the daemon lives only as long as a login session.
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
cork start        # background daemon (launchd agent on macOS, systemd --user unit on Linux)
cork status       # check daemon
cork session list # list active sessions
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
| `cork start`      | Start the daemon under the platform service manager — `launchd` (macOS) or `systemd --user` (Linux); auto‑restarts and runs at login/boot |
| `cork start --foreground` | Run in the current shell (for debugging)              |
| `cork stop`       | Stop the daemon                                               |
| `cork restart`    | `stop` + `start`                                              |
| `cork status`     | Show daemon state, socket, and how many sessions are live     |
| `cork session list` | List live sessions: chat, workspace, Claude context, `tmux attach` command |

### In‑chat slash commands

Send these from Lark — they are handled by the daemon, not by Claude:

| Command                | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `/status`              | Show this chat's session state (workspace, last activity, …)  |
| `/new`                 | Throw away the current Claude session and start a fresh one   |
| `/workspace <path>`    | Re‑point this chat at a different working directory           |
| `/mention-on` / `/mention-off` | Toggle whether `@bot` is required for the bot to react in groups |

### Your own slash commands

Drop an executable in `~/.cork/commands` and it becomes a command named after
the file — `~/.cork/commands/deploy` answers `/deploy`. The daemon runs it
before the message reaches Claude, so it costs one process spawn instead of a
model turn and behaves the same every time.

```sh
#!/bin/sh
# description: one line saying what this does
set -eu
echo "Ran for $1 in $CORK_CHAT_NAME"
```

`chmod +x` it and it is live — no restart. It receives everything after the
command as `$1` (unsplit), the message context as `CORK_*` environment
variables, and the whole message as JSON on stdin. Its stdout is posted back to
the chat — print nothing and nothing is posted, which is what you want when the
result is somewhere else. A non-zero exit posts what it wrote to stderr
instead. Built-ins above are matched first, so a script cannot shadow
`/status`.

The directory starts empty — cork ships no commands of its own. Two things help
when writing one:

```sh
cork send --chat <id> --channel <ch> --text <text> [--at <open_id>]  # post into any chat
cork session create --chat <id> --channel <ch>                       # warm a session for one
```

And note the daemon's PATH is a snapshot taken when cork was installed, not
your shell's — prefer absolute paths to tools you added later.

## Optional Lark events

Cork runs fine with none of these subscribed. Each unlocks one feature, and
skipping it costs **only that feature** — no message is ever dropped, delayed, or
failed because one is missing.

Subscribe to them for your bot app in the [Lark developer console](https://open.feishu.cn/app),
then `cork restart` so the daemon registers the new handlers.

| Feature | Enable | Where | If you skip it |
| ------- | ------ | ----- | -------------- |
| Free the session when a chat is disbanded | event `im.chat.disbanded_v1` | Events & callbacks | The chat's Claude process and tmux pane stay alive until the next `cork restart`, and the chat keeps appearing in `cork session list` |
| Same, when the bot is removed from a chat that survives | event `im.chat.member.bot.deleted_v1` | Events & callbacks | Same |

## Configuration

All state lives under `~/.cork/`:

```
~/.cork/
├── config.jsonc        # main config (created by `cork setup`)
├── env                 # extra env vars exported to every claude session (one KEY=VALUE per line)
├── mcp-config.json     # auto‑written; points claude at the cork channel MCP
├── claude-settings.json # auto‑written; the Stop hook every session runs with
├── cork.sock           # UDS the channel MCP connects to
├── sessions/           # per‑chat metadata
├── commands/           # your slash commands: one executable per command
├── spool/              # CLI → daemon command queue; entries are consumed and deleted
├── agent/              # auto‑written; cork's injected skill, passed to claude via --add-dir
└── logs/               # cork.log (+ launchd stdout/stderr on macOS; journald on Linux)
```

`~/.cork/env` is the easy way to pass things like `ANTHROPIC_MODEL` or proxy settings to every Claude session — the service manager (`launchd`/`systemd`) doesn't read your shell rc files, so exports there won't reach Claude otherwise.

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

**`cork status` says daemon is running but `cork session list` shows none.**
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

## License

MIT
