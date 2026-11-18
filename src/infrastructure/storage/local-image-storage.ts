import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import multer from "multer";

export const uploadDirectory = path.resolve(process.env.UPLOAD_DIR ?? "uploads");
const extensions: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" };
export const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { void mkdir(uploadDirectory, { recursive: true }).then(() => cb(null, uploadDirectory), error => cb(error as Error, uploadDirectory)); },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${extensions[file.mimetype] ?? ".invalid"}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, Boolean(extensions[file.mimetype]))
});
