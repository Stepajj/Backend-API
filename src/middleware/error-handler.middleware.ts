import type { ErrorRequestHandler } from "express";

export const errorHandlerMiddleware: ErrorRequestHandler = (
  err,
  req,
  res,
  next
) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  const prismaCode = typeof err?.code === "string" ? err.code : undefined;
  const multerCode = typeof err?.code === "string" && err?.name === "MulterError" ? err.code : undefined;
  const databaseErrors: Record<string, { status: number; code: string; message: string }> = {
    P2002: { status: 409, code: "CONFLICT", message: "A record with these values already exists" },
    P2025: { status: 404, code: "NOT_FOUND", message: "The requested record was not found" },
    P2003: { status: 400, code: "INVALID_REFERENCE", message: "A referenced record does not exist" },
    P2000: { status: 400, code: "VALIDATION_ERROR", message: "A value exceeds the supported length" }
  };
  const databaseError = prismaCode ? databaseErrors[prismaCode] : undefined;
  const uploadTooLarge = multerCode === "LIMIT_FILE_SIZE";
  const invalidUpload = Boolean(multerCode && !uploadTooLarge);
  const bodyTooLarge = err?.type === "entity.too.large";
  const bodyLimitMessage = req.path.startsWith("/api/v1/payments/stripe/webhook") ? "Webhook request body exceeds the 1 MB size limit" : "Request body exceeds the 10 KB size limit";
  const requestedStatus = typeof err?.status === "number" && err.status >= 400 && err.status <= 599 ? err.status : undefined;
  const status = databaseError?.status ?? (uploadTooLarge || bodyTooLarge ? 413 : invalidUpload ? 400 : requestedStatus ?? 500);
  const code = databaseError?.code ?? (uploadTooLarge ? "UPLOAD_TOO_LARGE" : bodyTooLarge ? "BODY_TOO_LARGE" : invalidUpload ? "INVALID_UPLOAD" : requestedStatus ? (err?.code ?? "REQUEST_FAILED") : "INTERNAL_SERVER_ERROR");
  const message = databaseError?.message ?? (uploadTooLarge ? "Image exceeds the 5 MB size limit" : bodyTooLarge ? bodyLimitMessage : invalidUpload ? "Invalid image upload" : status >= 500 ? "Internal server error" : String(err?.message ?? "Request failed"));
  if (status >= 500) req.log?.error({ err }, "Request failed");
  else req.log?.warn({ code, status }, "Request rejected");
  res.status(status).json({
    error: {
      code,
      message
    }
  });
};
