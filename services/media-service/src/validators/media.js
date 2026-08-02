import { z } from "zod";

/**
 * MVP allowlist: every MIME the media service accepts, grouped by kind with a
 * per-kind size cap. Everything else is rejected at upload-url issuance, so no
 * unexpected content ever reaches storage. (Magic-byte sniffing is a noted gap
 * — see ARCHITECTURE.md "Media Service".)
 */
export const MEDIA_RULES = [
  { kind: "image", mimes: ["image/jpeg", "image/png", "image/gif", "image/webp"], maxBytes: 15 * 1024 * 1024 },
  { kind: "audio", mimes: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/aac", "audio/mp4"], maxBytes: 15 * 1024 * 1024 },
  { kind: "video", mimes: ["video/mp4", "video/mov", "video/webm"], maxBytes: 100 * 1024 * 1024 },
  { kind: "document", mimes: ["application/pdf"], maxBytes: 10 * 1024 * 1024 },
  { kind: "text", mimes: ["text/plain", "text/markdown", "text/csv", "application/json"], maxBytes: 2 * 1024 * 1024 },
];

/** The stored media_type value for a rule kind (stored, not re-inferred). */
export function mediaTypeOf(kind) {
  return kind.toUpperCase(); // IMAGE | VIDEO | AUDIO | DOCUMENT | TEXT
}

export const UPLOAD_URL_TTL_SECONDS = 60; // presigned PUT
export const MEDIA_URL_TTL_SECONDS = 600; // signed GET ("CDN-style" delivery)

export function ruleFor(contentType) {
  return MEDIA_RULES.find((rule) => rule.mimes.includes(contentType)) ?? null;
}

/** Strips any path and control chars; keeps a safe, readable filename. */
export function safeFilename(name) {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]/g, "_").trim();
  return (cleaned || "file").slice(0, 255);
}

/** Client claims size/type up front; the confirm step re-checks actual bytes. */
export const uploadUrlSchema = z
  .object({
    filename: z.string().min(1, "filename must not be empty").max(255),
    content_type: z.string().min(1).max(127),
    size: z.number().int().positive("size must be a positive byte count"),
  })
  .strict();

export const idParamSchema = z.object({
  id: z.string().uuid("Must be a valid UUID"),
});

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

export function validateParams(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    next();
  };
}

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
