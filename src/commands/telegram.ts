import { loadConfig, saveConfig } from "../config/loader.js";

/**
 * Add a Telegram numeric user id to the allowlist (config.channels.telegram.owners)
 * and persist. Restart the daemon for the change to take effect.
 */
export async function telegramAllow(userId: string): Promise<void> {
  const id = userId.trim();
  const config = loadConfig();
  if (!config.channels.telegram) {
    console.error("Telegram is not configured. Run 'cork setup telegram' first.");
    process.exit(1);
  }
  const owners = config.channels.telegram.owners;
  if (owners.includes(id)) {
    console.log(`${id} is already allowlisted.`);
    return;
  }
  owners.push(id);
  saveConfig(config);
  console.log(`✓ Allowlisted ${id}. Restart the daemon for it to take effect: cork restart`);
}

/**
 * Remove a Telegram numeric user id from the allowlist and persist.
 */
export async function telegramDeny(userId: string): Promise<void> {
  const id = userId.trim();
  const config = loadConfig();
  if (!config.channels.telegram) {
    console.error("Telegram is not configured. Run 'cork setup telegram' first.");
    process.exit(1);
  }
  const owners = config.channels.telegram.owners;
  const idx = owners.indexOf(id);
  if (idx < 0) {
    console.log(`${id} is not on the allowlist.`);
    return;
  }
  owners.splice(idx, 1);
  saveConfig(config);
  console.log(`✓ Removed ${id}. Restart the daemon for it to take effect: cork restart`);
}
