# Cork — Design Document

A CLI daemon that bridges IM channels (Feishu/Lark) to Claude Code subprocesses, providing per-chat session isolation, streaming replies, and workspace management.

## 1. Architecture

```
┌─────────────────────────────────────────────────────────┐
│            IM Channel (Lark WebSocket)                   │
└──────────────────────┬──────────────────────────────────┘
                       │ Events
                       ▼
┌─────────────────────────────────────────────────────────┐
│                    Cork Daemon                           │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │   Channel    │  │   Router     │  │ Session Mgr   │  │
│  │   Adapter    │──│  + Queue     │──│  + Process    │  │
│  └─────────────┘  └──────────────┘  └───────────────┘  │
│         │                │                    │          │
│         │          ┌─────┴─────┐              │          │
│         │          ▼           ▼              ▼          │
│         │    ┌──────────┐ ┌──────────┐ ┌───────────┐   │
│         │    │ Commands │ │ Ack Mgr  │ │ Claude    │   │
│         │    │ Handler  │ │ (Emoji)  │ │ Process   │   │
│         │    └──────────┘ └──────────┘ └───────────┘   │
│         │                                               │
│    ┌────┴────────┐                                      │
│    │ Event       │ Content parsing, access control,     │
│    │ Dispatcher  │ dedup, quote/merge-forward, media    │
│    └─────────────┘                                      │
└─────────────────────────────────────────────────────────┘
                       │
          stream-json stdin/stdout
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  ┌───────────┐  ┌───────────┐  ┌───────────┐
  │ Claude    │  │ Claude    │  │ Claude    │
  │ Code #1   │  │ Code #2   │  │ Code #3   │
  │ (chat_a   │  │ (chat_b   │  │ (chat_a   │
  │  + ws_1)  │  │  + ws_1)  │  │  + ws_2)  │
  └───────────┘  └───────────┘  └───────────┘
```

### Message Flow

```
Lark WebSocket Event
  → events.ts: dedup → stale check → type filter → access control → content parse
    → strip @mentions → handle /mention-on|off → download media → resolve quotes/merge-forward
      → router.handleMessage()
        → ChatQueue (FIFO per chat)
          → commands.ts: /status, /new, /workspace?
            → (if not command) SessionManager.processMessage()
              → ClaudeProcess.spawn() or reuse
                → stdin: JSON message
                → stdout: streaming events → decision window → card or post reply
```

## 2. Core Concepts

### 2.1 Session

A session is a running Claude Code subprocess bound to a `(chat_id, workspace)` pair.

- **Session Key**: `sha256(chat_id + ":" + workspace_path)` truncated to 16 hex chars
- **Session ID**: UUID, passed to Claude Code via `--session-id` (new) or `-r` (resume)
- **Lifecycle**: created on first message → persisted to disk → restored via `claude -r <session_id>` on next startup
- **Isolation**: each session runs in its own workspace directory

### 2.2 Workspace

A local directory that serves as the working directory for a Claude Code subprocess.

- Default workspace configured in `~/.cork/config.jsonc`
- Switchable per chat via `/workspace <path>`
- Switching workspace within a chat creates or resumes a different session
- Non-existent paths are auto-created

### 2.3 Owner & Access Control

Only designated owners can interact with the bot.

- Identified by Feishu `open_id`, configured in `config.jsonc` under `channels.lark.owners`
- Auto-detected during `cork setup` via QR code or manual flow
- If `owners` is empty, all users are allowed

**Private chat (P2P):**
- Only owner messages are processed; non-owner messages are silently ignored

**Group chat:**
- Owner + `@bot` mention required by default
- Non-owner `@bot` → rejection reply; non-owner without `@bot` → silently ignored
- `/mention-off` command disables the `@bot` requirement (owner messages processed without mention)
- `/mention-on` re-enables the requirement
- Mention setting is persisted per chat in `chat_setting_lark_{chatId}.json`

## 3. CLI Commands

### 3.1 `cork setup [channel]`

Interactive channel configuration wizard.

```bash
cork setup lark    # Configure Feishu/Lark channel (default)
```

**First run** also prompts for global settings (default workspace path).

**QR Code Flow:**
1. Call Feishu App Registration API (`/oauth/v1/app/registration`)
2. Display QR code via `qrcode-terminal`
3. Poll until user scans with Feishu app
4. Auto-detect domain from `tenant_brand` (`feishu` or `lark`)
5. Extract `appId`, `appSecret`, owner `open_id`

**Manual Flow:**
1. Prompt for App ID + App Secret
2. Auto-detect domain by trying both `open.feishu.cn` and `open.larksuite.com`
3. Validate credentials

### 3.2 `cork start`

```bash
cork start              # Start as background daemon via launchd
cork start --foreground # Run in foreground (interactive, for debugging)
```

**Background mode** (default): generates a launchd plist at `~/Library/LaunchAgents/com.cork.daemon.plist`, then calls `launchctl load` + `launchctl start`. The plist invokes `cork start --daemon` internally.

**Foreground mode** (`--foreground`): runs the daemon loop directly in the current terminal.

**`--daemon` flag**: used internally by the launchd plist. Behaves like `--foreground` but skips duplicate-process checks (launchd handles single-instance). This flag makes `ps` output distinguishable: `cork start --daemon` = launched by launchd, `cork start --foreground` = launched by user.

**Startup checks:**
- Detect and prevent duplicate cork processes (launchd or manual)
- Detect and auto-kill orphaned Claude Code processes from previous cork sessions (matched by `--output-format stream-json` + known session ID)

**launchd configuration:**
- `KeepAlive: true` — auto-restart on crash
- `RunAtLoad: true` — auto-start on login
- Preserves `PATH` and `HOME` environment variables

### 3.3 `cork stop`

```bash
cork stop
```

Calls `launchctl unload` and removes the plist file. The daemon receives SIGTERM and gracefully shuts down all Claude Code subprocesses.

### 3.4 `cork status`

```bash
cork status
```

Shows daemon status (running/stopped, PID) and lists all sessions with chat name, workspace, Claude session ID, and last activity.

## 4. Chat Commands

Commands sent in chat (private or group). Handled before routing to Claude Code.

| Command | Description |
|---------|-------------|
| `/new` | Create a new session in the current workspace |
| `/new <path>` | Create a new session in a specified workspace |
| `/workspace` | Show current workspace path |
| `/workspace <path>` | Switch workspace (resumes existing session if available) |
| `/status` | Show session info (chat type, mention setting, workspace, session ID, status) |
| `/mention-off` | Disable @bot requirement in group chat |
| `/mention-on` | Re-enable @bot requirement in group chat |

## 5. Message Processing

### 5.1 Inbound Pipeline (events.ts)

1. **Deduplication** — 1-minute TTL cache (Lark delivers at-least-once)
2. **Stale rejection** — Messages older than 30 seconds at startup are ignored
3. **Message type filter** — Supports: text, post, image, file, audio, media, sticker, interactive, merge_forward, share_chat, share_user, location
4. **Access control** — Owner check + group @bot check (see §2.3)
5. **Content parsing** — Extract text from various message types (content.ts)
6. **Mention stripping** — Remove `@bot` text from group messages
7. **Chat commands** — `/mention-on` and `/mention-off` processed inline
8. **Resource download** — Images/files downloaded to `/tmp/cork-media/` with MIME-inferred extensions
9. **Quoted message** — Fetch parent message via API, resolve sender name, format as blockquote with timestamp
10. **Merge-forward** — Fetch sub-message tree, resolve sender names, format hierarchically
11. **Ack reaction** — Add configurable emoji reaction (default: `OnIt`)
12. **Dispatch** — Route to MessageRouter

### 5.2 Outbound Pipeline (SessionManager)

1. Parse Claude Code stdout (stream-json events)
2. On first text chunk → start 500ms decision window
3. **Short reply** (complete within window) → send as `post` rich text (lightweight, no card border)
4. **Streaming reply** (window expires) → create interactive card, throttle updates every 500ms
5. On `result` event → final update or standalone reply
6. Remove ack reaction

### 5.3 Per-Chat Queue

Messages from the same chat are processed serially (FIFO). Different chats run in parallel.

### 5.4 Content Audit (DLP)

If Lark rejects a message with error code 230028 (content audit failure), Cork masks sensitive patterns (emails, phone numbers, IPs) and retries once.

### 5.5 Quoted Message Format

```
> [2026-04-16 15:30] Zhang San:
> quoted message content

user's reply text
```

### 5.6 Merge-Forward Format

```
<forwarded_messages>
[2026-04-16 15:30] Zhang San:
    message content line 1
    message content line 2

[2026-04-16 15:31] Li Si:
    another message
</forwarded_messages>
```

Sender names are resolved via Lark API for users, bot name for self, "Bot" for other bots.

## 6. Claude Code Integration

### 6.1 Persistent Process Model

Each session maintains a long-lived `claude` process. Multiple conversation turns are handled via stdin/stdout without restarting.

**New session:**
```bash
claude -p --output-format stream-json --verbose --input-format stream-json \
  --session-id <uuid> [--dangerously-skip-permissions] [extra-args...]
```

**Resume session:**
```bash
claude -p --output-format stream-json --verbose --input-format stream-json \
  -r <session-id> [--dangerously-skip-permissions] [extra-args...]
```

### 6.2 stream-json Protocol

**Input (stdin):**
```json
{"type": "user", "message": {"role": "user", "content": "message text"}}
```

**Output (stdout):**

| Event | Description |
|-------|-------------|
| `system` (subtype: `init`) | Session init with `session_id`, `tools`, `model` |
| `assistant` | Streaming text in `message.content[].text` |
| `result` (subtype: `success`) | Turn complete, final text in `result` field |

### 6.3 Error Recovery

- Process crash (non-zero exit) → notify user, auto-resume via `-r` on next message
- Errors never destroy session metadata; only `/new` creates a fresh session
- Orphaned processes from prior cork sessions are auto-killed on startup

## 7. Persistence

### 7.1 File Layout

```
~/.cork/
├── config.jsonc                         # Main configuration (JSONC)
├── sessions/
│   ├── <session_key>.json               # Session metadata
│   └── chat_setting_lark_<chatId>.json  # Per-chat settings (mention mode)
├── logs/
│   ├── cork.log                         # Application log (winston JSON)
│   ├── stdout.log                       # launchd stdout
│   └── stderr.log                       # launchd stderr
~/Library/LaunchAgents/
└── com.cork.daemon.plist                # launchd service definition
```

### 7.2 config.jsonc

```jsonc
{
  "defaultWorkspace": "~/Workspace",
  "claude": {
    "permissionMode": "bypassPermissions",
    "extraArgs": []
  },
  "channels": {
    "lark": {
      "appId": "cli_xxxx",
      "appSecret": "xxxx",
      "domain": "feishu",           // "feishu" or "lark", auto-detected
      "owners": ["ou_xxxx"],        // empty = allow all
      "ackEmoji": "OnIt",
      "streamingIntervalMs": 500,
      "idleTimeoutMin": 0           // 0 = never auto-terminate
    }
  }
}
```

### 7.3 Session Metadata

```json
{
  "sessionId": "uuid",
  "chatId": "oc_xxxx",
  "chatType": "p2p",
  "chatName": "Zhang San",
  "workspace": "/Users/xxx/Workspace",
  "createdAt": "2026-04-15T12:00:00.000Z",
  "lastActiveAt": "2026-04-15T14:30:00.000Z",
  "lastMessagePreview": "message preview (50 chars)"
}
```

## 8. Project Structure

```
cork/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # CLI entry (commander)
│   ├── logger.ts                 # Winston logger with custom Logger interface
│   ├── commands/
│   │   ├── setup.ts              # cork setup
│   │   ├── start.ts              # cork start (foreground + launchd)
│   │   └── lifecycle.ts          # cork stop, cork status
│   ├── daemon/
│   │   ├── daemon.ts             # Daemon lifecycle (start/stop channels)
│   │   └── signal.ts             # SIGTERM/SIGINT/uncaughtException handlers
│   ├── dispatcher/
│   │   ├── router.ts             # MessageRouter (dispatch to queue → command or session)
│   │   ├── queue.ts              # Per-chat FIFO message queue
│   │   └── commands.ts           # /new, /workspace, /status handlers
│   ├── session/
│   │   ├── manager.ts            # Session lifecycle, process spawn, streaming reply
│   │   ├── process.ts            # Claude Code subprocess wrapper (spawn, stdin/stdout)
│   │   └── store.ts              # Session metadata persistence (JSON files)
│   ├── channels/
│   │   ├── types.ts              # Channel, Dispatcher, IncomingMessage interfaces
│   │   ├── lark/
│   │   │   ├── index.ts          # LarkChannel class (implements Channel)
│   │   │   ├── client.ts         # Lark SDK wrapper (API calls, bot info, user names)
│   │   │   ├── events.ts         # WebSocket event handler (access control, content pipeline)
│   │   │   ├── content.ts        # Message content parsing & resource extraction
│   │   │   ├── card.ts           # Interactive card & post rich text builders
│   │   │   ├── chat-settings.ts  # Per-chat settings (mention mode, cached + persisted)
│   │   │   ├── merge-forward.ts  # Forwarded message tree formatter
│   │   │   └── setup.ts          # QR code & manual setup flows
│   │   └── test/
│   │       └── index.ts          # In-process test channel (no network)
│   └── config/
│       ├── schema.ts             # Config type definitions
│       ├── loader.ts             # JSONC config reader/writer, path resolver
│       └── paths.ts              # ~/.cork/ path constants
└── tests/
    └── integration.test.ts       # End-to-end tests with real Claude Code
```

## 9. Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Node.js ≥ 22 | Match Claude Code requirement |
| Language | TypeScript | Type safety |
| Package Manager | pnpm | Fast, disk-efficient |
| Lark SDK | `@larksuiteoapi/node-sdk` | Official SDK with WebSocket |
| CLI | `commander` | Lightweight, standard |
| Prompts | `@inquirer/prompts` | Interactive setup |
| QR Code | `qrcode-terminal` | Terminal QR display |
| Logging | `winston` | JSON file logging, child loggers |
| Config | `jsonc-parser` | JSONC support (comments in config) |
| Testing | `vitest` | Fast, ESM-native |
| Process Mgmt | `node:child_process` | Built-in spawn with stdio pipes |
| Service Mgmt | launchd (macOS) | Crash restart, login auto-start |

## 10. Testing

Integration tests use a `TestChannel` that implements the same `Channel` interface as Lark but operates in-process without network:

- `injectMessage()` — simulate user input
- `getFinalReplies()` — collect bot responses
- Tests spawn real Claude Code subprocesses (consumes API tokens)

**Test cases:**
- Single message → reply received
- Multi-turn conversation → context preserved
- Different chats → session isolation
- `/new` → fresh session created
- `/workspace` → workspace show and switch

## 11. Non-Goals (v1)

- Multi-platform service management (Linux systemd, Windows)
- Web dashboard
- Plugin system
- Permission confirmation interaction via chat
- Message retry via emoji reaction
- Rate limiting
- Forwarding tool_use/tool_result events to chat
