import { input } from "@inquirer/prompts";
import type { TelegramChannelConfig } from "../../config/schema.js";

/**
 * Validate a BotFather token by calling getMe, returning the bot username.
 * Throws on an invalid token or unreachable API.
 */
async function validateToken(token: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  } catch (err) {
    // A corporate TLS-inspecting proxy re-signs api.telegram.org with a CA that
    // the OS trusts but Node does not, surfacing here as a bare "fetch failed".
    // Node only reads its own bundled roots; point NODE_EXTRA_CA_CERTS at the CA
    // to append it (see README).
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    if (cause?.includes("CERT") || cause?.includes("SELF_SIGNED")) {
      throw new Error(
        `TLS verification failed (${cause}). If you are behind a TLS-inspecting ` +
          `proxy, export NODE_EXTRA_CA_CERTS=/path/to/corp-ca.pem and retry.`
      );
    }
    throw err;
  }

  const data = (await res.json()) as {
    ok: boolean;
    result?: { username?: string };
    description?: string;
  };
  if (!data.ok || !data.result?.username) {
    throw new Error(data.description || "invalid token");
  }
  return data.result.username;
}

/**
 * Run the Telegram setup flow: paste the BotFather token (validated live),
 * optionally seed the owner allowlist with your own numeric user id.
 */
export async function runTelegramSetup(): Promise<TelegramChannelConfig> {
  const token = await input({
    message: "Paste your BotFather bot token:",
    validate: (v) => (v.trim() ? true : "Token is required"),
  });

  let username = "";
  try {
    username = await validateToken(token.trim());
    console.log(`✓ Token verified — bot is @${username}`);
  } catch (err) {
    throw new Error(
      `Token validation failed: ${(err as Error).message}. Check the token from BotFather.`
    );
  }

  const ownerId = await input({
    message:
      "Your Telegram numeric user id (optional — DM @userinfobot to get it; " +
      "leave blank to pair later by messaging the bot):",
    default: "",
  });

  const owners = ownerId.trim() ? [ownerId.trim()] : [];

  return {
    token: token.trim(),
    owners,
    // Echo unknown senders during onboarding so you can learn your id and get
    // allowlisted. Switch to "drop" once configured.
    unknownSender: "echo",
    ackReaction: "👀",
  };
}
