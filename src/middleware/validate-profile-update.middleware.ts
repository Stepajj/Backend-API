import type { RequestHandler } from "express";
import { profileUpdateSchema } from "../schemas/profile.schema.js";

export const validateProfileUpdateMiddleware: RequestHandler = (
  req,
  res,
  next
) => {
  const result = profileUpdateSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: {
        code: "INVALID_INPUT",
        message: "Invalid profile data",
        details: result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message
        }))
      }
    });
    return;
  }

  req.body = result.data;
  next();
};