import winston from "winston";
import fs from "node:fs";
import { paths } from "./config/paths.js";

const { combine, timestamp, printf, errors } = winston.format;

const logFormat = printf(({ level, message, timestamp, name, ...rest }) => {
  const meta = { level, time: timestamp, name, ...rest, msg: message };
  return JSON.stringify(meta);
});

const rootLogger = winston.createLogger({
  level: "debug",
  format: combine(
    errors({ stack: false }),
    timestamp({ format: () => new Date().toISOString() }),
    logFormat
  ),
  transports: [
    new winston.transports.Console(),
  ],
});

/**
 * Enable writing logs to file in addition to console.
 * All existing loggers (child loggers) share the same transports,
 * so this takes effect immediately for all loggers.
 */
export function enableLogFile(): void {
  fs.mkdirSync(paths.logsDir, { recursive: true });

  rootLogger.add(
    new winston.transports.File({
      filename: paths.logFile,
      level: "debug",
    })
  );
}

/**
 * Logger interface with winston-style calling conventions.
 * Accepts `logger.info("msg")` or `logger.info("msg", {meta})`.
 */
export interface Logger {
  fatal(msg: string): void;
  fatal(msg: string, meta: object): void;
  error(msg: string): void;
  error(msg: string, meta: object): void;
  warn(msg: string): void;
  warn(msg: string, meta: object): void;
  info(msg: string): void;
  info(msg: string, meta: object): void;
  debug(msg: string): void;
  debug(msg: string, meta: object): void;
  child(bindings: object): Logger;
}

function wrapWinston(wLogger: winston.Logger): Logger {
  function makeMethod(level: string) {
    return (...args: any[]) => {
      if (args.length >= 2 && typeof args[0] === "string" && typeof args[1] === "object") {
        // winston-style: logger.info("message", {key: val})
        (wLogger as any)[level](args[0], args[1]);
      } else {
        (wLogger as any)[level](args[0]);
      }
    };
  }

  return {
    fatal: makeMethod("error"), // winston has no fatal; map to error
    error: makeMethod("error"),
    warn: makeMethod("warn"),
    info: makeMethod("info"),
    debug: makeMethod("debug"),
    child(bindings: object): Logger {
      return wrapWinston(wLogger.child(bindings));
    },
  };
}

/**
 * Get a named child logger. All child loggers share the root
 * logger's transports, so enableLogFile() affects them all.
 */
export function getLogger(name: string): Logger {
  return wrapWinston(rootLogger.child({ name }));
}
