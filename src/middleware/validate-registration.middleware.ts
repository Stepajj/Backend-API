import type { RequestHandler } from "express";
import { registrationSchema } from "../schemas/auth.schema.js";

export const validateRegistrationMiddleware: RequestHandler = (
  req,
  res,
  next
) => {
  const result = registrationSchema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      error: {
        code: "INVALID_INPUT",
        message: "Invalid registration data",
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