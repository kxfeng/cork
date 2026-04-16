import type { Channel } from "../channels/types.js";
import { MessageRouter } from "../dispatcher/router.js";
import type { CorkConfig } from "../config/schema.js";
import { ensureDirs } from "../config/loader.js";
import { getLogger } from "../logger.js";

const logger = getLogger("daemon");

export class CorkDaemon {
  private router: MessageRouter;
  private channels: Channel[] = [];
  private running = false;

  constructor(
    private config: CorkConfig,
    channels: Channel[]
  ) {
    this.router = new MessageRouter(config);
    this.channels = channels;
  }

  get dispatcher(): MessageRouter {
    return this.router;
  }

  async start(): Promise<void> {
    ensureDirs();
    logger.info("starting cork daemon");

    for (const channel of this.channels) {
      logger.info("starting channel", { channel: channel.name });
      await channel.start(this.router);
    }

    this.running = true;
    logger.info("cork daemon started");
  }

  async stop(): Promise<void> {
    logger.info("stopping cork daemon");
    this.running = false;

    for (const channel of this.channels) {
      await channel.stop();
    }

    await this.router.shutdown();
    logger.info("cork daemon stopped");
  }

  isRunning(): boolean {
    return this.running;
  }
}
