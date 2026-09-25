import { editConfigValue, loadConfig } from "../config/loader.js";

/**
 * `cork lark allow` / `cork lark disallow`: edit channels.lark.allows — who may
 * talk to the bot without commanding it — from the shell. The same list
 * `/allow @someone` edits in chat.
 *
 * There is deliberately no command for owners. Owners may run every chat
 * command, and granting that stays a matter of editing config.jsonc by hand.
 *
 * Written in place, so the comments and layout of config.jsonc survive. The
 * running daemon reads its config at start, so this needs `cork restart`;
 * `/allow` in chat takes effect at once.
 */
function larkConfig() {
  const config = loadConfig();
  if (!config.channels.lark) {
    console.error("Lark is not configured. Run 'cork setup' first.");
    process.exit(1);
  }
  return config.channels.lark;
}

export async function larkAllow(openIds: string[]): Promise<void> {
  const lark = larkConfig();
  const allows = [...(lark.allows ?? [])];
  const added: string[] = [];
  for (const raw of openIds) {
    const id = raw.trim();
    if (!id) continue;
    if (lark.owners.includes(id)) console.log(`${id} is an owner — it may talk to the bot already.`);
    else if (allows.includes(id)) console.log(`${id} is already allowed.`);
    else {
      allows.push(id);
      added.push(id);
    }
  }
  if (added.length === 0) return;
  editConfigValue(["channels", "lark", "allows"], allows);
  console.log(`✓ Allowed ${added.join(", ")}. Restart the daemon for it to take effect: cork restart`);
}

export async function larkDisallow(openIds: string[]): Promise<void> {
  const lark = larkConfig();
  const allows = [...(lark.allows ?? [])];
  const removed: string[] = [];
  for (const raw of openIds) {
    const id = raw.trim();
    const i = allows.indexOf(id);
    if (i < 0) {
      console.log(
        lark.owners.includes(id)
          ? `${id} is an owner, not on the allows list — owners are edited in ~/.cork/config.jsonc.`
          : `${id} is not on the allows list.`
      );
      continue;
    }
    allows.splice(i, 1);
    removed.push(id);
  }
  if (removed.length === 0) return;
  editConfigValue(["channels", "lark", "allows"], allows);
  console.log(`✓ Disallowed ${removed.join(", ")}. Restart the daemon for it to take effect: cork restart`);
}
