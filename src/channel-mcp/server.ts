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
    instructions:
      "Messages from Lark arrive as <channel source=\"cork-channel\" ...>. " +
      "Reply using the cork-channel__reply tool. Always reply to every message.",
  }
);

// Reply tool: Claude calls this to send a message back to Lark
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply message back to the Lark chat",
      inputSchema: {
        type: "object" as const,
        properties: {
          text: {
            type: "string",
            description: "The message text to send",
          },
        },
        required: ["text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "reply") {
    const { text } = req.params.arguments as { text: string };
    try {
      udsClient.send({
        type: "reply",
        corkSessionKey: sessionKey!,
        content: text,
      });
      return { content: [{ type: "text" as const, text: "sent" }] };
    } catch (err) {
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
    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: (msg.content as string) || "",
        meta,
      },
    });
  } else if (msg.type === "permission_verdict") {
    // Forward permission verdict to Claude Code
    await mcp.notification({
      method: "notifications/claude/channel/permission" as any,
      params: {
        request_id: msg.requestId as string,
        behavior: msg.behavior as string,
      },
    } as any);
  }
});

// Connect to cork daemon (called once Claude Code completes MCP handshake)
async function connectToCork() {
  const maxRetries = 10;
  const retryDelayMs = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await udsClient.connect();
      process.stderr.write(
        `cork-channel: connected to cork daemon (session: ${sessionKey})\n`
      );
      return;
    } catch (err) {
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

// Connect to UDS only after Claude Code completes MCP handshake (initialized notification)
mcp.oninitialized = () => {
  connectToCork();
};

// Start: connect MCP stdio
async function main() {
  await mcp.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`cork-channel fatal: ${err}\n`);
  process.exit(1);
});
