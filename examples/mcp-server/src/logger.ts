import pino from "pino";

/**
 * Every log line goes to stderr. On the stdio transport stdout carries the
 * JSON-RPC stream, so a single stray byte written there desynchronises the
 * client. Nothing in this package may use console.log for the same reason.
 */
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  pino.destination(2),
);
