import app from "./app.js";
import {env} from './config/env.js';
import { prisma } from "./infrastructure/database/prisma.js";
import { logger } from "./infrastructure/logging/logger.js";

const port = env.port;

async function start(): Promise<void> {
  await prisma.$connect();
  const server = app.listen(port, () => {
    logger.info({ port, nodeEnv: env.nodeEnv }, "HTTP server listening");
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.keepAliveTimeout = 5_000;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => { void prisma.$disconnect(); });
      const shutdownTimeout = setTimeout(() => process.exit(1), 10_000);
      shutdownTimeout.unref();
    });
  }
}

start().catch(async error => {
  logger.fatal({ err: error }, "Application startup failed");
  await prisma.$disconnect();
  process.exitCode = 1;
});
