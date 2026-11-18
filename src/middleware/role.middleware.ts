import type { RequestHandler } from "express";

export function requireRole(...roles: Array<"BUYER" | "SELLER" | "ADMIN">): RequestHandler {
  return async (req, res, next) => {
    try {
    if (!req.auth?.userId) { res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }); return; }
    if (!roles.includes(req.auth.role)) { res.status(403).json({ error: { code: "FORBIDDEN", message: "Insufficient permissions" } }); return; }
    next();
    } catch (error) {
      next(error);
    }
  };
}
