---
name: cork
description: How cork's user-defined slash commands work — one executable per command under ~/.cork/commands, run by the daemon before a message ever reaches the model. Use when asked to add, change, list or debug a cork command (e.g. "add a /deploy command", "what commands do I have", "/foo isn't working"), or when a message starting with a slash was expected to be handled and reached you instead.
---

# Cork commands

Cork bridges Lark and Telegram chats to Claude Code. Alongside its built-in
slash commands it runs **user-defined ones**: one executable per command in
`~/.cork/commands`, named after the command it answers.

```
~/.cork/commands/deploy     →  /deploy
~/.cork/commands/standup    →  /standup
```

The daemon matches these **before** a message reaches the model, so a command
costs one process spawn instead of a whole turn, and behaves the same every
time. **You do not execute these commands** — if a `/name` message reaches you,
the command does not exist, is not executable, or was rejected (see
Troubleshooting).

Your job here is to help the owner **write and maintain** them.

## What a command receives

**`$1`** — everything typed after the command, as one string. `/deploy my
service` gives `$1 = "my service"`. It is not split on spaces, so no quoting
games.

**Environment** — the message context, ready to use:

```
CORK_CHANNEL      lark | telegram
CORK_CHAT_ID      the chat it was sent in
CORK_CHAT_TYPE    p2p | group
CORK_CHAT_NAME    display name of that chat
CORK_THREAD_ID    thread id, empty outside a thread
CORK_SENDER_ID    who sent it (Lark open id)
CORK_MESSAGE_ID   the triggering message
CORK_SESSION_KEY  cork's key for this session
CORK_WORKSPACE    that session's workspace
CORK_TEXT         the full message text
```

**stdin** — the whole message as JSON, for fields the variables above do not
name.

**cwd** — the session's workspace.

## What a command returns

- **stdout** → posted back to the chat as Markdown. In a thread, it answers in
  that thread.
- **empty stdout** → nothing is posted at all. This is the right shape for a
  command whose result is elsewhere — it created a group, or already spoke
  through `cork send` — and keeps it from adding noise to the chat it was sent
  from. The ack reaction appearing and clearing is the only trace it leaves.
- **non-zero exit** → cork posts the tail of stderr behind a ❌, or the exit
  code if the command wrote nothing. So write the message you want the user to
  see to stderr, and exit non-zero.
- **stderr** → goes to `~/.cork/logs/cork.log` either way.

A condition that is not an error — "this only works on Lark" — reads better as
stdout with exit 0: it is posted as plain text, with no ❌.

Limits: 60s, then the command and anything it spawned are killed; stdout over
8KB is truncated.

## Writing one

```sh
#!/bin/sh
# description: one line saying what this does
set -eu

[ -n "${1:-}" ] || { echo "usage: /example <arg>" >&2; exit 2; }
echo "Ran for $1 in $CORK_CHAT_NAME"
```

Then `chmod +x ~/.cork/commands/example`. It is live immediately — no restart.

Rules that will otherwise bite:

- **The name is the filename**: lowercase letters, digits and hyphens, no
  extension. `deploy.sh` answers `/deploy.sh`, which is not what anyone wants.
- **Must be executable and not writable by others**, or cork ignores it (it
  runs as the daemon user).
- **Built-ins win.** `/status`, `/new`, `/workspace`, `/mention-off`,
  `/mention-on`, `/autopilot` are matched first; a script by those names is dead
  weight.
- **PATH is a snapshot** taken when cork was installed (it lives in the launchd
  plist), not your shell's live PATH. A tool installed later may not be on it —
  prefer absolute paths, or check the plist before assuming.
- **Long work should not block.** The command holds that chat's queue while it
  runs. Kick off anything slow in the background and report progress with
  `cork send`.

## Useful from inside a command

- `cork send --chat <id> --channel <ch> --text <text> [--at <open_id>]` — post
  into any chat, including one that was just created.
- `cork session create --chat <id> --channel <ch>` — warm a Claude session for
  a chat.

Both return immediately; the daemon does the work.

## Listing what exists

`ls -l ~/.cork/commands` — the `# description:` line near the top of each file
says what it does.

## Troubleshooting

A `/name` message reaching you instead of running means one of:

- no file `~/.cork/commands/name`
- the file has no executable bit
- it is writable by group or others, or owned by someone else
- the name has characters outside `[a-z0-9-]`

`~/.cork/logs/cork.log` records which of these it was — cork logs the reason
rather than posting a permissions detail into the chat.

Cork ships no commands of its own: the directory starts empty and holds only
what the owner put there.
