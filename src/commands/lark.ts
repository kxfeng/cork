import { loadConfig, saveConfig } from "../config/loader.js";

/**
 * Add a Lark open id to the allowlist (config.channels.lark.owners) and
 * persist. Restart the daemon for the change to take effect.
 *
 * This is the command the bot names when it turns someone away with no
 * allowlist configured — the rejection carries the sender's own open id, so
 * the operator can paste it straight back here. Without that pairing the
 * rejection would be a dead end: the id Lark uses is not something anyone
 * knows offhand.
 */
export async function larkAllow(openId: string): Promise<void> {
  const id = openId.trim();
  const config = loadConfig();
  if (!config.channels.lark) {
    console.error("Lark is not configured. Run 'cork setup' first.");
    process.exit(1);
  }
  const owners = config.channels.lark.owners;
  if (owners.includes(id)) {
    console.log(`${id} is already allowlisted.`);
    return;
  }
  owners.push(id);
  saveConfig(config);
  console.log(`✓ Allowlisted ${id}. Restart the daemon for it to take effect: cork restart`);
}

/**
 * Remove a Lark open id from the allowlist and persist.
 *
 * Emptying the list entirely leaves a bot that serves nobody, so this says so
 * rather than letting the operator discover it from the silence.
 */
export async function larkDeny(openId: string): Promise<void> {
  const id = openId.trim();
  const config = loadConfig();
  if (!config.channels.lark) {
    console.error("Lark is not configured. Run 'cork setup' first.");
    process.exit(1);
  }
  const owners = config.channels.lark.owners;
  const idx = owners.indexOf(id);
  if (idx < 0) {
    console.log(`${id} is not on the allowlist.`);
    return;
  }
  owners.splice(idx, 1);
  saveConfig(config);
  console.log(`✓ Removed ${id}. Restart the daemon for it to take effect: cork restart`);
  if (owners.length === 0) {
    console.log("⚠️ The allowlist is now empty — the bot will refuse everyone.");
  }
}
