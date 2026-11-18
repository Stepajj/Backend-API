import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  redact: { paths: ["password", "passwordHash", "token", "authorization", "cookie", "stripe-signature"], censor: "[REDACTED]" }
});
