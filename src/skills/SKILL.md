---
name: cork
description: Cork operational commands for Claude Code sessions bridged to Lark/Telegram chats. Invoke ONLY on an explicit slash command from the list below — never on a vague paraphrase. Supported commands: /new-chat (create a new chat session).
---

# Cork

Cork bridges Lark and Telegram group chats to Claude Code. This skill provides
cork's operational commands. Each command is triggered by its **literal** slash
command — match the exact command, never a paraphrase.

## Commands

- `/new-chat <title>` — create a new chat session.

<!-- Future commands: add one bullet here, and a matching "## /<command>" section
     below. Keep the same shape — Trigger, then a per-platform branch. -->

## /new-chat — create a new chat session

**Trigger:** the user's message is the literal slash command `/new-chat <title>`.
Never fire on paraphrases like "let's start a task" or "open a new group" — a
vague match must NOT create a session.

**Platform branch.** cork-channel tells you this session's platform ("Messages
from Lark …" vs "Messages from Telegram …"). Dispatch on it:

- **Lark** → follow the Lark section below.
- **Any other platform (e.g. Telegram)** → not implemented yet. Reply that
  `/new-chat` currently supports Lark only, and do nothing else.

### Lark

Run the whole flow as **one** shell invocation, exactly as below. The chat id
flows from step to step through a variable, so nothing here needs a second look
at a previous result — and every extra round trip is time the user spends
staring at a chat where nothing has happened yet.

Substitute only `<title>`, `<greeting>` and `<senderId>` before running. Do not
hardcode identities or ids: the app id is read from cork's config, and the owner
is the current conversation's initiator (their `senderId`).

```
APP_ID=$(jq -r '.channels.lark.appId' ~/.cork/config.jsonc)
CID=$(lark-cli im +chat-create --as user --name "CoKo · <title>" --bots "$APP_ID" \
      | jq -r '.data.chat_id')
[ -n "$CID" ] && [ "$CID" != "null" ] || { echo "chat-create failed"; exit 1; }
cork send --chat "$CID" --text "<greeting>" --at <senderId>
cork session create --chat "$CID"
echo "created $CID"
```

**Greeting.** Write it in the same language the initiator wrote in — translate
when they used another language. Keep it about the session itself, not about
tasks or work. The English form is:

> Your session is ready. What would you like to talk about?

Order matters and the script already encodes it: create the group and greet
FIRST, warm the session LAST — the user sees the new group the moment it is
created, with no waiting. `cork send` and `cork session create` both return
immediately; the daemon does the work. When the script succeeds, tell the user
the group is ready and to head there.
