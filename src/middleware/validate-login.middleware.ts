import { loginSchema } from '../schemas/auth.schema.js';
import { RequestHandler } from "express";

export const validateLoginMiddleware: RequestHandler = (
    req,
    res,
    next

) => {
    const result = loginSchema.safeParse(req.body);

    if (!result.success) {
        res.status(400).json({
            error: {
                code: "INVALID_INPUT",
                message: "Invalid login data",
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
}