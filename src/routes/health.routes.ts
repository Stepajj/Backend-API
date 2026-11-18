import { Router } from "express";

const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  res.status(200).json({
    status: "ok"
  });
});

healthRouter.get("/ready", async (_req, res) => {
  try {
    const { prisma } = await import("../infrastructure/database/prisma.js");
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({ status: "ready", dependencies: { database: "ok" } });
  } catch {
    return res.status(503).json({ status: "not_ready", dependencies: { database: "unavailable" } });
  }
});


export default healthRouter;
