import pino, { type LoggerOptions } from "pino";

// Fastify v5 expects logger to be a boolean or a config object, not a pino instance.
// Keep a single shared config so both Fastify and our standalone modules share settings.
export const loggerConfig = {
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.LINEAR_API_KEY",
      "*.OPENAI_API_KEY",
      "*.MEM0_API_KEY",
      "*.LINEAR_WEBHOOK_SECRET",
    ],
    remove: true,
  },
} satisfies LoggerOptions;

export const logger = pino(loggerConfig);
