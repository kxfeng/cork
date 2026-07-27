---
name: cork
description: Cork operational commands for Claude Code sessions bridged to Lark/Telegram chats. Invoke ONLY on an explicit slash command from the list below — never on a vague paraphrase. Supported commands: /new-chat (create a new task session).
---

# Cork

Cork bridges Lark and Telegram group chats to Claude Code. This skill provides
cork's operational commands. Each command is triggered by its **literal** slash
command — match the exact command, never a paraphrase.

## Commands

- `/new-chat <title>` — create a new task session.

<!-- Future commands: add one bullet here, and a matching "## /<command>" section
     below. Keep the same shape — Trigger, then a per-platform branch. -->

## /new-chat — create a new task session

**Trigger:** the user's message is the literal slash command `/new-chat <title>`.
Never fire on paraphrases like "let's start a task" or "open a new group" — a
vague match must NOT create a session.

**Platform branch.** cork-channel tells you this session's platform ("Messages
from Lark …" vs "Messages from Telegram …"). Dispatch on it:

- **Lark** → follow the steps in the Lark section below.
- **Any other platform (e.g. Telegram)** → not implemented yet. Reply that
  `/new-chat` currently supports Lark only, and do nothing else.

### Lark

Do not hardcode identities or ids. The owner is the current conversation's
initiator (their `senderId`). Read the bot's app id from cork's config rather
than baking it in:
```
APP_ID=$(jq -r '.channels.lark.appId' ~/.cork/config.jsonc)
```

1. Create the group and invite the bot (user identity, so the user becomes the owner):
   ```
   lark-cli im +chat-create --as user --name "CoKo · <title>" --bots "$APP_ID"
   ```
   Take the `chat_id` (looks like `oc_…`) from the returned JSON.

2. Send the greeting as the bot and @mention the initiator (openId = current senderId):
   ```
   cork send --chat <chat_id> --text "Your task session is ready. What would you like to work on?" --at <senderId>
   ```

3. Warm the session (cork starts Claude in the background — non-blocking, default workspace):
   ```
   cork session create --chat <chat_id>
   ```

Order matters: create the group and greet FIRST, warm the session LAST — the user
sees the new group the moment it is created, with no waiting. When done, tell the
user the group is ready and to head there to start the task.
