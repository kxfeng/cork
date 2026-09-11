#!/usr/bin/env node
/**
 * Cork Channel MCP Server
 *
 * Runs inside Claude Code as a channel MCP server.
 * Bridges Claude Code ↔ Cork daemon via Unix Domain Socket.
 *
 * Environment variables:
 * - CORK_SESSION_KEY: session key for registration (required)
 * - CORK_SOCKET: UDS path (default: ~/.cork/cork.sock)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { UdsClient } from "./uds-client.js";

const sessionKey = process.env.CORK_SESSION_KEY;
const sockPath =
  process.env.CORK_SOCKET ||
  path.join(os.homedir(), ".cork", "cork.sock");

if (!sessionKey) {
  process.stderr.write("CORK_SESSION_KEY environment variable is required\n");
  process.exit(1);
}

// Per-subprocess JSON-line log. Stderr inside an MCP subprocess is captured
// by claude code and not easy to retrieve, so we keep our own file. All
// active sessions append to the same file; each line is tagged with
// sessionKey + pid so it can be grepped per-session and time-aligned with
// ~/.cork/logs/cork.log when debugging the MCP / channel handshake.
const logFile = path.join(os.homedir(), ".cork", "logs", "channel-mcp.log");
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    sessionKey,
    pid: process.pid,
    event,
    ...fields,
  }) + "\n";
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // logging must never crash the bridge
  }
}

log("subprocess_started", { sockPath });

// Which platform this session talks to. Passed explicitly by the daemon: the
// session key is an opaque id and no longer spells out the channel. Surface it
// in the tool description — a Telegram session must not be told it is replying
// to Lark.
const channelName = process.env.CORK_CHANNEL_NAME || "lark";
const platform = channelName.charAt(0).toUpperCase() + channelName.slice(1);

// Create the MCP server with channel capability
const mcp = new Server(
  { name: "cork-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    // "Always reply to every message" used to stand here on its own, and it is
    // the wrong instruction for a room. It reads as a duty owed to the message
    // rather than to the person, so a remark passing between two other people
    // earns an answer, and an exchange that has run out of substance earns one
    // more acknowledgement. Between two of these bots that is not merely noisy:
    // both sides hold this same line, so neither can be the one to stop.
    //
    // The other bot is named, but only as something that may be true of whoever
    // is talking. The model is never asked to work out which correspondent is
    // one — it cannot, since the channel tag carries a name and an id but not a
    // kind — and it does not need to: "is this addressed to me" and "is this
    // still going anywhere" are questions about the conversation, answerable
    // from what is already in front of it. Saying "another bot" rather than
    // "answering automatically" is for concreteness; a named thing to picture
    // beats an abstraction when the point is to make the risk feel real.
    instructions:
      `Messages from ${platform} arrive as <channel source="cork-channel" ...>. ` +
      "Reply using the cork-channel__reply tool. Reply text supports Markdown.\n\n" +
      "Answer what is addressed to you. A group also shows you messages meant " +
      "for someone else — reading one of those and staying out of it is the " +
      "right call, not a failure to respond. And when an exchange has stopped " +
      "producing anything new, let it end rather than acknowledge it once " +
      "more: a group can hold other bots, one of which may be answering you " +
      "automatically, and two correspondents who each reply to everything " +
      "never stop.\n\n" +
      "When you decide not to answer, still call the tool, with an empty " +
      "text. Nothing is sent to the chat — it is how you say you read this " +
      "and are letting it pass, and it closes the turn cleanly.",
  }
);

// Reply tool: Claude calls this to send a message back to the chat it came from
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        `Send a reply message back to the ${platform} chat. ` +
        "The reply text supports Markdown. To include an image, reference a " +
        "local file inline as `![](/abs/path.png)` and it is uploaded and shown " +
        "at that spot. To attach other files, pass their paths in `files`.",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description:
              "The reply text. Markdown is supported. A local image referenced " +
              "as `![](/abs/path.png)` is uploaded and inlined where it appears; " +
              "references inside code blocks, remote URLs, and paths that do not " +
              "exist are left as literal text. Empty means you have chosen not " +
              "to answer: no message reaches the chat, and the turn ends there. " +
              "Use it for a message addressed to someone else, or an exchange " +
              "with nothing left in it — it says the same thing as silence and " +
              "costs a great deal less.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description:
              "Absolute paths of local files to attach. Each is sent as its own " +
              "message after the text. Use this for documents and other " +
              "non-image files; images are better inlined via `![](path)`.",
          },
          replyToMessageId: {
            type: "string",
            description:
              "The `messageId` of the message this reply is about, copied from " +
              "the `<channel>` tag it arrived in. The reply then renders as a " +
              "quote showing who was replied to and a snippet of what they " +
              "said, which is worth doing in a busy group where a bare reply " +
              "reads as unattached — and worth skipping in a quiet chat, where " +
              "quoting every message is noise. Note that quoting a message " +
              "which already has a thread pulls the reply into that thread, " +
              "out of the main chat.",
          },
          at: {
            type: "string",
            description:
              "The `senderId` of someone to @mention at the head of the reply, " +
              "copied from the `<channel>` tag of a message they sent. A quote " +
              "alone is easy to miss in a busy group; an @ notifies them and " +
              "names them in plain sight, so it is worth adding when answering " +
              "one person among several. Skip it in a direct message, where " +
              "there is nobody to distinguish from, and skip it when nothing " +
              "is being addressed to anyone in particular — an @ on every " +
              "message stops meaning anything. Only a `senderId` that appeared " +
              "on a channel tag works; a name on its own cannot be turned into " +
              "one.",
          },
        },
        required: ["text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text, files, replyToMessageId, at } = req.params.arguments as {
      text: string;
      files?: string[];
      replyToMessageId?: string;
      at?: string;
    };
    log("reply_tool_called", {
      contentLen: text.length,
      files: files?.length ?? 0,
      // Logged as a flag, not a value: enough to tell a dropped parameter from
      // one the model never sent, without putting a member's id in the log.
      at: !!at,
      udsConnected: udsClient.connected,
    });
    try {
      udsClient.send({
        type: "reply",
        corkSessionKey: sessionKey!,
        content: text,
        ...(files?.length ? { files } : {}),
        ...(replyToMessageId ? { replyToMessageId } : {}),
        ...(at ? { at } : {}),
      });
      log("reply_sent_to_uds");
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
      log("reply_send_failed", { err: (err as Error).message });
      return {
        content: [
          {
            type: "text" as const,
            text: `failed to send: ${(err as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

// Permission relay: forward permission prompts from Claude Code to Lark via cork
const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  try {
    udsClient.send({
      type: "permission_request",
      corkSessionKey: sessionKey!,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
      requestId: params.request_id,
    });
  } catch {
    // Can't forward, user will need to approve in terminal
  }
});

// UDS client: connects to cork daemon
const udsClient = new UdsClient(sockPath, sessionKey);

// Handle incoming messages from cork daemon
udsClient.on("message", async (msg) => {
  if (msg.type === "message") {
    // Forward to Claude Code as channel notification
    const meta: Record<string, string> = {};
    if (msg.meta && typeof msg.meta === "object") {
      for (const [k, v] of Object.entries(msg.meta as Record<string, unknown>)) {
        if (typeof v === "string") meta[k] = v;
      }
    }
    const contentLen = ((msg.content as string) || "").length;
    log("recv_message_from_cork", { contentLen });
    try {
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: (msg.content as string) || "",
          meta,
        },
      });
      log("forwarded_to_claude", { contentLen });
    } catch (err) {
      log("forward_to_claude_failed", { err: (err as Error).message });
    }
  } else if (msg.type === "permission_verdict") {
    // Forward permission verdict to Claude Code
    log("recv_permission_verdict", { requestId: msg.requestId });
    await mcp.notification({
      method: "notifications/claude/channel/permission" as any,
      params: {
        request_id: msg.requestId as string,
        behavior: msg.behavior as string,
      },
    } as any);
  }
});

udsClient.on("connected", () => log("uds_connected"));
udsClient.on("disconnected", () => log("uds_disconnected"));
udsClient.on("error", (err: Error) => log("uds_error", { err: err.message }));

// Connect to cork daemon (called once Claude Code completes MCP handshake)
async function connectToCork() {
  const maxRetries = 10;
  const retryDelayMs = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      log("uds_connect_attempt", { attempt: i + 1 });
      await udsClient.connect();
      process.stderr.write(
        `cork-channel: connected to cork daemon (session: ${sessionKey})\n`
      );
      return;
    } catch (err) {
      log("uds_connect_failed", {
        attempt: i + 1,
        err: (err as Error).message,
      });
      if (i < maxRetries - 1) {
        process.stderr.write(
          `cork-channel: waiting for cork daemon (attempt ${i + 1}/${maxRetries})...\n`
        );
        await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        process.stderr.write(
          `cork-channel: failed to connect to cork daemon after ${maxRetries} attempts\n`
        );
        // Continue running — MCP still works, just no cork bridge
      }
    }
  }
}

// Settle window between MCP `notifications/initialized` and registering
// with the cork daemon.
//
// Without it, the cork side dumps any queued user messages the instant
// register lands — which can be tens of milliseconds after `initialized`
// on a warm machine. Claude code's MCP layer is initialized at that point
// but its per-channel state machine may not have finished wiring; the
// channel notification arrives, claude shows the message text in the TUI
// but treats cork-channel as "not yet open" and refuses to call the
// reply tool. The next message (seconds later) goes through fine.
//
// Anthropic's official telegram channel doesn't need this delay because
// Telegram polling naturally adds ~1-2s of network latency before the
// first inbound message arrives. Cork queues messages on the daemon side
// and floods them on register, collapsing that buffer to ~0ms.
//
// 1s is empirically enough; raise if first-message races reappear.
const REGISTER_SETTLE_MS = 1000;

mcp.oninitialized = () => {
  log("mcp_oninitialized");
  setTimeout(() => {
    log("register_settle_elapsed");
    connectToCork();
  }, REGISTER_SETTLE_MS);
};

// Start: connect MCP stdio
async function main() {
  log("mcp_connecting_stdio");
  await mcp.connect(new StdioServerTransport());
  log("mcp_stdio_connected");
}

main().catch((err) => {
  log("fatal", { err: (err as Error).message });
  process.stderr.write(`cork-channel fatal: ${err}\n`);
  process.exit(1);
});
