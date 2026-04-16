import { input } from "@inquirer/prompts";
import { loadConfig, saveConfig } from "../config/loader.js";
import { runLarkSetup } from "../channels/lark/setup.js";

export async function setupCommand(channelName?: string): Promise<void> {
  const config = loadConfig();

  // First run: prompt for global settings if not configured
  if (config.defaultWorkspace === "~/Workspace") {
    const workspace = await input({
      message: "默认工作区路径 Default workspace path:",
      default: "~/Workspace",
    });
    config.defaultWorkspace = workspace;
  }

  if (!channelName || channelName === "lark") {
    console.log("\n--- Lark/Feishu Channel Setup ---\n");
    const larkConfig = await runLarkSetup();
    config.channels.lark = larkConfig;
  } else {
    console.log(`Channel "${channelName}" is not supported yet.`);
    return;
  }

  saveConfig(config);
  console.log(`\n✓ Configuration saved to ~/.cork/config.jsonc`);
  console.log(`\nRun "cork start --foreground" to start the daemon.`);
}
