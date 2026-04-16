import type { CorkDaemon } from "./daemon.js";
import { getLogger } from "../logger.js";

const logger = getLogger("signal");

export function setupSignalHandlers(daemon: CorkDaemon): void {
  const shutdown = async (signal: string) => {
    logger.info("received signal, shutting down", { signal });
    await daemon.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    logger.fatal("uncaught exception", { err });
    daemon.stop().finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { reason });
  });
}
