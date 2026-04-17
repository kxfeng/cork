# Cork — Design Document

A CLI daemon that bridges IM channels (Feishu/Lark) to Claude Code sessions via MCP Channel protocol, providing per-chat session isolation, interactive terminal visibility, and workspace management.

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│              IM Channel (Lark WebSocket)                     │
└───────────────────────┬─────────────────────────────────────┘
                        │ Events
                        ▼
┌─────────────────────────────────────────────────────────────┐
│                     Cork Daemon                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐    │
│  │   Channel     │  │   Router     │  │ Session Mgr    │    │
│  │   Adapter     │──│  + Queue     │──│  + tmux Mgr    │    │
│  │  (Lark WS)   │  │              │  │                 │    │
│  └──────────────┘  └──────────────┘  └────────┬───────┘    │
│         │                │                     │            │
│    ┌────┴─────────┐ ┌────┴─────┐               │            │
│    │ Event        │ │ Commands │               │            │
│    │ Dispatcher   │ │ Handler  │               │            │
│    └──────────────┘ └──────────┘               │            │
│                                                │            │
│  ┌─────────────────────────────────────────────┤            │
│  │          UDS Server (~/.cork/cork.sock)      │            │
│  └──────────────┬──────────────────────────────┘            │
└─────────────────┼───────────────────────────────────────────┘
                  │ Unix Domain Socket
        ┌─────────┼─────────┐
        ▼         ▼         ▼
  ┌──────────┐ ┌──────────┐ ┌──────────┐
  │ tmux #1  │ │ tmux #2  │ │ tmux #3  │    ← user can attach/detach
  │┌────────┐│ │┌────────┐│ │┌────────┐│
  ││ Claude ││ ││ Claude ││ ││ Claude ││    ← launched with --mcp-config
  ││ Code   ││ ││ Code   ││ ││ Code   ││       ~/.cork/mcp-config.json
  ││ ┌────┐ ││ ││ ┌────┐ ││ ││ ┌────┐ ││
  ││ │MCP ││ ││ │MCP ││ ││ │MCP ││      ← cork-channel MCP (per session)
  ││ │Chan││ ││ │Chan││ ││ │Chan││         CORK_SESSION_KEY in env
  ││ └──┬─┘ ││ ││ └──┬─┘ ││ ││ └──┬─┘ ││
  │└────┼───┘│ │└────┼───┘│ │└────┼───┘│
  └─────┼────┘ └─────┼────┘ └─────┼────┘
        └────────────┼────────────┘
                     │ connect to cork.sock (after MCP `initialized`)
```

### Message Flow

```
Inbound (Lark → Claude Code):
  Lark WebSocket Event
    → events.ts: dedup → stale check → type filter → access control → content parse
      → strip @mentions → handle /mention-on|off → download media → resolve quotes
        → router.handleMessage()
          → ChatQueue (FIFO per chat)
            → commands.ts: /status, /new, /workspace?
              → (if not command) SessionManager.dispatch()
                → session state check:
                    inactive  → start tmux + claude code, queue message, state → starting
                    starting  → queue message (wait for channel MCP to register)
                    connected → push message via UDS to channel MCP

Outbound (Claude Code → Lark):
  Claude Code generates reply
    → calls channel MCP's `reply` tool
      → channel MCP sends reply via UDS to cork daemon
        → cork sends to Lark (card or post)

Channel MCP Registration:
  Claude Code starts in tmux (--mcp-config ~/.cork/mcp-config.json)
    → spawns cork-channel MCP as subprocess (CORK_SESSION_KEY in env)
      → MCP completes JSON-RPC handshake
        → MCP receives `notifications/initialized` from Claude Code
          → MCP connects to ~/.cork/cork.sock
            → sends register { corkSessionKey }
              → cork waits for: register AND (channel-confirmation Enter + 1500ms)
                → state: starting → connected, queued messages flushed
```

## 2. Core Concepts

### 2.1 Session

A session binds a chat conversation to a Claude Code instance running in tmux.

- **Session Key**: `{channelId}_{chatId}`, e.g. `lark_oc_e21e11a61c56575e557f73370733c6de`
- **Claude Session ID**: UUID, passed to Claude Code via `--session-id` (new) or `-r` (resume)
- **Workspace**: fixed at session creation time, not changeable afterward
- **Lifecycle**: created on first message → Claude Code spawned in tmux → channel MCP connects via UDS → messages flow bidirectionally
- **Isolation**: each session runs in its own tmux session with its own workspace directory

### 2.2 Session States

```
inactive → starting → connected
    ↑          |           |
    |       timeout/       |
    |       failure        |
    |__________|     disconnect
    |______________________|
```

| State | Description | On new message |
|-------|-------------|----------------|
| `inactive` | No tmux/claude process | Start tmux + claude code, queue message, → `starting` |
| `starting` | tmux launched, waiting for channel MCP to be ready | Queue message (no duplicate launch) |
| `connected` | Channel MCP fully ready, queue flushed | Push message directly to channel |

**Two-phase readiness for `starting → connected`**:

To avoid sending channel notifications before Claude Code can consume them, two events must happen:
1. Channel MCP registers via UDS (only fires after Claude Code's MCP `initialized` notification, see §3.3)
2. Cork's auto-`Enter` for the development-channel confirmation dialog has been sent + 1500ms

The transition fires whichever happens last. If register arrives before the Enter is sent, registration is deferred until Enter+1500ms; if register arrives after, it's delayed by however much remains of the 1500ms window.

- **Starting timeout** (30s): if channel MCP doesn't become ready in time, state → `inactive`, queued messages cleared, error notification sent to Lark
- **Disconnect**: channel MCP connection drops (claude code exit), state → `inactive`

### 2.3 Workspace

A local directory that serves as the working directory for a Claude Code session.

- Default workspace configured in `~/.cork/config.jsonc`
- Fixed per session at creation time
- `/new <path>` creates a new session with a different workspace
- Non-existent paths are auto-created

### 2.4 Owner & Access Control

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
- Mention setting (`mentionRequired`) is persisted on the session metadata file (see §7.3)

## 3. Communication Protocol

### 3.1 UDS Server

Cork daemon runs a Unix Domain Socket server at `~/.cork/cork.sock`. All channel MCP instances connect to this single socket.

**Why UDS over WebSocket/HTTP:**
- Purely local, no port conflicts
- More reliable than TCP, no heartbeat/reconnect complexity
- Socket path is deterministic

### 3.2 Message Protocol (over UDS)

JSON-line protocol, one JSON object per line:

**Channel → Cork (register):**
```json
{"type": "register", "corkSessionKey": "lark_oc_xxx"}
```

**Cork → Channel (incoming message):**
```json
{"type": "message", "content": "user message text", "meta": {"chatId": "oc_xxx", "senderId": "ou_xxx", "messageId": "om_xxx"}}
```

**Channel → Cork (reply):**
```json
{"type": "reply", "corkSessionKey": "lark_oc_xxx", "content": "claude's reply", "streaming": true, "updateMessageId": "om_yyy"}
```

**Channel → Cork (permission relay):**
```json
{"type": "permission_request", "corkSessionKey": "lark_oc_xxx", "toolName": "Bash", "description": "run ls -la", "requestId": "abcde"}
```

**Cork → Channel (permission verdict):**
```json
{"type": "permission_verdict", "requestId": "abcde", "behavior": "allow"}
```

### 3.3 Channel MCP (cork-channel)

An MCP server that runs inside Claude Code, bridging Claude Code ↔ Cork daemon.

**Capabilities:**
- `claude/channel` — receive notifications from Claude Code
- `claude/channel/permission` — relay permission prompts to Lark
- `tools` — expose `reply` tool for Claude to send messages

**Configuration:**
- A single global MCP config file at `~/.cork/mcp-config.json` registers the `cork-channel` server. Cork writes this file on first session start. All sessions share it; per-session identity is passed via env, not config.
- Claude Code is launched with `--mcp-config ~/.cork/mcp-config.json --dangerously-load-development-channels server:cork-channel` (see §3.4).

**Environment variables (set by cork when launching tmux):**
- `CORK_SESSION_KEY` — session key for registration (passed via the tmux shell command, inherited by Claude Code → MCP subprocess)
- `CORK_SOCKET` — UDS path (default: `~/.cork/cork.sock`, set inside `mcp-config.json`)

**MCP Tool:**
```typescript
{
  name: "reply",
  description: "Send a reply to the Lark chat",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The message to send" }
    },
    required: ["text"]
  }
}
```

**Instructions (injected into Claude's system prompt):**
```
Messages from Lark arrive as <channel source="cork-channel" ...>. Reply using the cork-channel__reply tool. Always reply to every message.
```

**Registration timing:**

The MCP server connects to Cork's UDS only after Claude Code sends the standard MCP `notifications/initialized` (handled via the SDK's `oninitialized` callback). This guarantees the MCP handshake is complete before Cork considers the channel reachable, eliminating a race where Cork would push a channel notification before Claude was listening.

A second guard exists at the Cork side (see §2.2): even after register, Cork waits until 1500ms past its auto-`Enter` for the development-channel confirmation dialog before flushing queued messages.

### 3.4 tmux Management

Cork manages Claude Code instances via tmux. tmux is required because Claude Code only accepts channel notifications in interactive mode (it auto-falls back to `-p` print-mode when stdin is not a TTY); tmux provides the required PTY.

**Create session (first time, no prior Claude session):**
```bash
tmux new-session -d -s "cork_{sessionKey}" -x 200 -y 50 \
  "cd '{workspace}' && CORK_SESSION_KEY='{key}' claude --session-id {uuid} \
   --dangerously-skip-permissions \
   --mcp-config ~/.cork/mcp-config.json \
   --dangerously-load-development-channels server:cork-channel"
```

**Resume session (Claude session previously connected):**
```bash
tmux new-session -d -s "cork_{sessionKey}" -x 200 -y 50 \
  "cd '{workspace}' && CORK_SESSION_KEY='{key}' claude -r {uuid} \
   --dangerously-skip-permissions \
   --mcp-config ~/.cork/mcp-config.json \
   --dangerously-load-development-channels server:cork-channel"
```

The choice between `--session-id` (new) and `-r` (resume) is driven by `claudeSessionStarted` on the session metadata, set to `true` only after the channel MCP first registers successfully (see §7.3).

**Auto-dismiss interactive dialogs:**

Even with `--dangerously-skip-permissions`, Claude Code displays two interactive prompts on first run:
1. Workspace trust dialog (~3s after launch) — auto-dismissed via `tmux send-keys ... Enter`
2. Development channel confirmation (~5s after launch) — auto-dismissed via `tmux send-keys ... Enter`. The timestamp of this Enter is recorded; readiness is gated until 1500ms after.

**User interaction:**
- `tmux attach -t cork_{sessionKey}` — view and interact with Claude Code
- `tmux attach -t cork_{sessionKey} -r` — view in read-only mode
- `Ctrl+B D` — detach without stopping Claude Code

`cork status` prints the exact `tmux attach` command for each session.

## 4. CLI Commands

### 4.1 `cork setup [channel]`

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

### 4.2 `cork start`

```bash
cork start              # Start as background daemon via launchd
cork start --foreground # Run in foreground (interactive, for debugging)
```

**Background mode** (default): generates a launchd plist at `~/Library/LaunchAgents/com.cork.daemon.plist`, then calls `launchctl load` + `launchctl start`. The plist invokes `cork start --daemon` internally.

**Foreground mode** (`--foreground`): runs the daemon loop directly in the current terminal.

**`--daemon` flag**: used internally by the launchd plist. Behaves like `--foreground` but skips duplicate-process checks (launchd handles single-instance).

**Startup sequence:**
1. Load config
2. Start UDS server on `~/.cork/cork.sock`
3. Connect Lark WebSocket
4. Ready to receive messages and channel MCP connections

**launchd configuration:**
- `KeepAlive: true` — auto-restart on crash
- `RunAtLoad: true` — auto-start on login
- Preserves `PATH` and `HOME` environment variables

### 4.3 `cork stop`

```bash
cork stop
```

Calls `launchctl unload` and removes the plist file. The daemon receives SIGTERM, closes UDS server, and disconnects from Lark.

Note: tmux sessions (Claude Code instances) continue running independently. They will reconnect when cork restarts.

### 4.4 `cork status`

```bash
cork status
```

Shows daemon status (running/stopped, PID via launchd) and lists all sessions with chat name, workspace, Claude session ID, last active time, last message preview, and the `tmux attach -t cork_{sessionKey}` command to view the live Claude Code interface.

### 4.5 `pnpm run link` (development)

```bash
pnpm run link    # Build (tsc) + npm link, install globally
```

Used during development to rebuild and re-install the `cork` CLI without restarting any running daemon. Restart cork manually after linking if you want changes to take effect: `cork stop && cork start`.

## 5. Chat Commands

Commands sent in chat (private or group). Handled before routing to Claude Code.

| Command | Description |
|---------|-------------|
| `/new` | Create a new session in the current workspace |
| `/new <path>` | Create a new session in a specified workspace |
| `/workspace` | Show current workspace path |
| `/status` | Show session info (chat type, mention setting, workspace, session state, tmux name) |
| `/mention-off` | Disable @bot requirement in group chat (requires @bot) |
| `/mention-on` | Re-enable @bot requirement in group chat (requires @bot) |

## 6. Message Processing

### 6.1 Inbound Pipeline (events.ts)

1. **Deduplication** — 1-minute TTL cache (Lark delivers at-least-once)
2. **Stale rejection** — Messages older than 30 seconds at startup are ignored
3. **Message type filter** — Supports: text, post, image, file, audio, media, sticker, interactive, merge_forward, share_chat, share_user, location
4. **Access control** — Owner check + group @bot check (see §2.4)
5. **Content parsing** — Extract text from various message types (content.ts)
6. **Mention stripping** — Remove `@bot` text from group messages
7. **Chat commands** — `/mention-on` and `/mention-off` processed inline
8. **Resource download** — Images/files downloaded to `/tmp/cork-media/` with MIME-inferred extensions
9. **Quoted message** — Fetch parent message via API, resolve sender name, format as blockquote with timestamp
10. **Merge-forward** — Fetch sub-message tree, resolve sender names, format hierarchically
11. **Ack reaction** — Add configurable emoji reaction (default: `OnIt`)
12. **Dispatch** — Route to MessageRouter → session → UDS → channel MCP → Claude Code
13. **Reaction handoff** — If dispatch was synchronous (chat command or dispatch error), remove the ack emoji immediately. Otherwise (Claude-handled), enqueue `(messageId, reactionId)` on the session's `pendingReactions` queue for later removal.

### 6.2 Outbound Pipeline (Channel MCP → Cork → Lark)

1. Claude Code generates complete reply, calls channel MCP's `reply` tool with full text
2. Channel MCP sends reply via UDS to cork daemon
3. Cork formats reply as Lark `post` rich text message
4. Cork sends to Lark API
5. After successful send, Cork pops the oldest entry from `session.pendingReactions` (FIFO) and removes that ack reaction. This guarantees the emoji stays visible until the user actually sees Claude's reply, instead of disappearing the moment Cork dispatches.

Note: MCP tool calls are request-response, not streaming. Lark users see ack emoji during processing, then the complete reply appears at once.

### 6.3 Per-Chat Queue

Messages from the same chat are processed serially (FIFO). Different chats run in parallel.

### 6.4 Content Audit (DLP)

If Lark rejects a message with error code 230028 (content audit failure), Cork masks sensitive patterns (emails, phone numbers, IPs) and retries once.

### 6.5 Quoted Message Format

```
> [2026-04-16 15:30] Zhang San:
> quoted message content

user's reply text
```

### 6.6 Merge-Forward Format

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

## 7. Persistence

### 7.1 File Layout

```
~/.cork/
├── config.jsonc                         # Main configuration (JSONC)
├── cork.sock                            # UDS server socket
├── mcp-config.json                      # Global MCP config consumed by Claude Code (--mcp-config)
├── sessions/
│   └── <session_key>.json               # Session metadata (includes mention setting)
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
  "lastMessagePreview": "first non-empty line (max 50 chars)",
  "claudeSessionStarted": true,
  "mentionRequired": true
}
```

**Field notes:**
- `claudeSessionStarted` — `false` until the channel MCP first registers successfully. Drives `--session-id` (false → start a new Claude session with this UUID) vs `-r` (true → resume).
- `lastMessagePreview` — only the first non-empty line of the user's message, truncated to 50 chars. Avoids ugly multi-line snippets in `cork status`.
- `mentionRequired` — replaces the legacy `chat_setting_lark_*.json` files. Toggled by `/mention-on` / `/mention-off` in group chats.

### 7.4 mcp-config.json

Written once on first session start, identical for all sessions. Per-session identity flows through the `CORK_SESSION_KEY` env var, not config.

```json
{
  "mcpServers": {
    "cork-channel": {
      "command": "node",
      "args": ["<resolved channel-mcp/server.js path>"],
      "env": {
        "CORK_SOCKET": "<absolute UDS path>"
      }
    }
  }
}
```

## 8. Project Structure

```
cork/
├── package.json
├── tsconfig.json
├── DESIGN.md
├── src/
│   ├── index.ts                  # CLI entry (commander)
│   ├── logger.ts                 # Winston logger with custom Logger interface
│   ├── commands/
│   │   ├── setup.ts              # cork setup
│   │   ├── start.ts              # cork start (foreground + launchd)
│   │   └── lifecycle.ts          # cork stop, cork status
│   ├── daemon/
│   │   ├── daemon.ts             # Daemon lifecycle (start UDS + channels), reply/permission handlers
│   │   ├── signal.ts             # SIGTERM/SIGINT/uncaughtException handlers
│   │   └── uds-server.ts         # Unix Domain Socket server
│   ├── dispatcher/
│   │   ├── router.ts             # MessageRouter (dispatch to queue → command or session)
│   │   ├── queue.ts              # Per-chat FIFO message queue
│   │   └── commands.ts           # /new, /workspace, /status handlers
│   ├── session/
│   │   ├── manager.ts            # Session lifecycle, state machine, tmux launch, mcp-config setup, pending reactions
│   │   └── store.ts              # Session metadata persistence (JSON files)
│   ├── channels/
│   │   ├── types.ts              # Channel, Dispatcher, IncomingMessage, DispatchResult interfaces
│   │   ├── lark/
│   │   │   ├── index.ts          # LarkChannel class (implements Channel)
│   │   │   ├── client.ts         # Lark SDK wrapper (API calls, bot info, user names)
│   │   │   ├── events.ts         # WebSocket event handler (access control, content pipeline, ack handoff)
│   │   │   ├── content.ts        # Message content parsing & resource extraction
│   │   │   ├── card.ts           # Interactive card & post rich text builders
│   │   │   ├── chat-settings.ts  # Mention setting (delegates to session metadata)
│   │   │   ├── merge-forward.ts  # Forwarded message tree formatter
│   │   │   └── setup.ts          # QR code & manual setup flows
│   │   └── test/
│   │       └── index.ts          # In-process test channel (no network)
│   ├── channel-mcp/
│   │   ├── server.ts             # MCP server (cork-channel) — runs inside Claude Code; UDS connect on `oninitialized`
│   │   └── uds-client.ts         # UDS client connecting to cork daemon
│   └── config/
│       ├── schema.ts             # Config type definitions
│       ├── loader.ts             # JSONC config reader/writer, path resolver
│       └── paths.ts              # ~/.cork/ path constants (incl. socketPath, mcpConfigPath)
├── tests/
│   ├── content.test.ts             # Message content parsing
│   ├── card.test.ts                # Card & post building
│   ├── chat-settings.test.ts       # Per-chat settings persistence
│   ├── merge-forward.test.ts       # Merge-forward formatting
│   ├── queue.test.ts               # Per-chat FIFO queue
│   ├── store.test.ts               # Session metadata persistence
│   ├── uds.test.ts                 # UDS server + client communication
│   ├── integration.test.ts         # End-to-end command flow with TestChannel (no Claude Code)
│   └── channel-integration.test.ts # End-to-end with real Claude Code in tmux (slow, requires `claude` CLI)
└── vitest.config.ts
```


## 9. Tech Stack

| Component | Choice | Reason |
|-----------|--------|--------|
| Runtime | Node.js >= 22 | Match Claude Code requirement |
| Language | TypeScript | Type safety |
| Package Manager | pnpm | Fast, disk-efficient |
| Lark SDK | `@larksuiteoapi/node-sdk` | Official SDK with WebSocket |
| MCP SDK | `@modelcontextprotocol/sdk` | Official MCP protocol SDK |
| CLI | `commander` | Lightweight, standard |
| Prompts | `@inquirer/prompts` | Interactive setup |
| QR Code | `qrcode-terminal` | Terminal QR display |
| Logging | `winston` | JSON file logging, child loggers |
| Config | `jsonc-parser` | JSONC support (comments in config) |
| Testing | `vitest` | Fast, ESM-native |
| Terminal Mux | `tmux` | Detachable terminal sessions |
| IPC | Unix Domain Socket | Local, reliable, no port conflicts |
| Service Mgmt | launchd (macOS) | Crash restart, login auto-start |

## 10. Testing

### 10.1 Unit Tests (no network, no subprocess)

Pure logic modules tested in isolation with vitest:

| Test file | Module | What it covers |
|-----------|--------|----------------|
| `content.test.ts` | `content.ts` | Text/post/image/file/card parsing, resource key extraction, edge cases |
| `card.test.ts` | `card.ts` | Card JSON structure, post content structure |
| `chat-settings.test.ts` | `chat-settings.ts` | Load/save/cache, defaults, corrupted file recovery |
| `merge-forward.test.ts` | `merge-forward.ts` | Flat/nested tree, sender name resolution, empty/single items |
| `queue.test.ts` | `queue.ts` | FIFO ordering, cross-chat parallelism, error isolation |
| `store.test.ts` | `store.ts` | Session CRUD, listing with chat_setting_ exclusion, sessionKey generation |

### 10.2 Integration Tests

| Test file | What it covers |
|-----------|----------------|
| `uds.test.ts` | UDS server lifecycle, channel registration, message routing, disconnect handling, reconnect |
| `integration.test.ts` | Daemon + TestChannel + commands (`/new`, `/workspace`, `/status`, `/new <path>`) — no Claude Code |
| `channel-integration.test.ts` | Full chain with real Claude Code in tmux: registration via UDS, single message → reply, multi-turn conversation. Slow; requires the `claude` CLI on PATH. |

### 10.3 Running Tests

```bash
pnpm test              # Run all tests once
pnpm test:watch        # Watch mode for development
```

## 11. Non-Goals (v1)

- Multi-platform service management (Linux systemd, Windows)
- Web dashboard
- Plugin system for custom channels
- Rate limiting
- Multi-user concurrent access to same session
