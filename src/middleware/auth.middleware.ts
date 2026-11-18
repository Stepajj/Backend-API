import type { RequestHandler } from "express";
import { jwtVerify } from "jose";

import { env } from "../config/env.js";
import { JWT_ISSUER, JWT_AUDIENCE } from "../security/jwt.constants.js";
import { prisma } from "../infrastructure/database/prisma.js";

export const authMiddleware: RequestHandler = async (req, res, next) => {
 try {
  const match = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
  const token = match?.[1];

  if (!token) {
    res.status(401).json({
      error: {
        code: "UNAUTHORIZED",
        message: "Access token required"
      }
    });
    return;
  }

  let userId: string;

  try {
    const { payload } = await jwtVerify(token, env.jwtAccessSecret, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      requiredClaims: ["exp", "iat", "sub"],
      typ: "JWT"
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new Error("JWT subject is missing");
    }

    userId = payload.sub;
  } catch {
    res.status(401).json({
      error: {
        code: "INVALID_ACCESS_TOKEN",
        message: "Access token is invalid or expired"
      }
    });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, status: true } });
  if (!user || user.status !== "ACTIVE") {
    res.status(401).json({ error: { code: "ACCOUNT_UNAVAILABLE", message: "Account is unavailable" } });
    return;
  }

  req.auth = { userId, role: user.role };

  next();
 } catch (error) {
   next(error);
 }
};
