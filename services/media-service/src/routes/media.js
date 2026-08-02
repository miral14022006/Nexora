import { Router } from "express";
import { randomUUID } from "node:crypto";
import { gatewayOnly } from "@nexora/internal-auth";
import { pool } from "../db/pool.js";
import { internalClient, publicClient } from "../minio.js";
import { config } from "../config.js";
import {
  asyncHandler,
  idParamSchema,
  MEDIA_RULES,
  MEDIA_URL_TTL_SECONDS,
  ruleFor,
  safeFilename,
  UPLOAD_URL_TTL_SECONDS,
  uploadUrlSchema,
  validate,
  validateParams,
} from "../validators/media.js";

const SELECT_MEDIA = `
  SELECT id, owner_id, filename, content_type, size, storage_key, status, created_at
  FROM media WHERE id = $1`;

function toMedia(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    filename: row.filename,
    contentType: row.content_type,
    size: Number(row.size), // BIGINT arrives as a string
    status: row.status,
    createdAt: row.created_at,
  };
}

export function createMediaRouter({ now = Date.now } = {}) {
  const router = Router();

  // When object storage is not configured (no MINIO_INTERNAL_ENDPOINT), the
  // service boots but every media operation is unavailable. Short-circuit
  // before auth so the 503 is explicit, not a misleading 403.
  router.use((req, res, next) => {
    if (config.minio.enabled) return next();
    res.status(503).json({ error: "Object storage is not configured" });
  });

  router.use(gatewayOnly);

  // ------------------------------------------------------------------ upload

  // 1. Client asks for a pre-signed upload URL. Type + size are validated
  //    HERE (cheap, before any bytes move) and again on confirm (actual bytes).
  router.post(
    "/upload-url",
    validate(uploadUrlSchema),
    asyncHandler(async (req, res) => {
      const { filename, content_type, size } = req.body;
      const ownerId = req.user.userId;

      const rule = ruleFor(content_type);
      if (!rule) {
        return res.status(400).json({
          error: "Unsupported media type",
          details: [
            {
              path: "content_type",
              message: `"${content_type}" is not supported; allowed: ${MEDIA_RULES.flatMap((r) => r.mimes).join(", ")}`,
            },
          ],
        });
      }
      if (size > rule.maxBytes) {
        return res.status(400).json({
          error: "File too large",
          details: [
            {
              path: "size",
              message: `${rule.kind} files are limited to ${Math.floor(rule.maxBytes / 1024 / 1024)} MB (got ${Math.floor(size / 1024 / 1024)} MB)`,
            },
          ],
        });
      }

      // storage_key = owner/user-ish scoping + unguessable object name.
      const mediaId = randomUUID();
      const name = safeFilename(filename);
      const storageKey = `${ownerId}/${mediaId}-${name}`;

      await pool.query(
        `INSERT INTO media (id, owner_id, filename, content_type, size, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [mediaId, ownerId, name, content_type, size, storageKey]
      );

      // The browser PUTs the file straight to this URL — chat-service never
      // proxies file bytes (see ARCHITECTURE.md "Media Service").
      const uploadUrl = await publicClient.presignedPutObject(
        config.minio.bucket,
        storageKey,
        UPLOAD_URL_TTL_SECONDS
      );

      return res.status(201).json({
        upload_id: mediaId,
        upload_url: uploadUrl,
        expires_in: UPLOAD_URL_TTL_SECONDS,
      });
    })
  );

  // 2. Client signals the upload finished. The stored size is cross-checked
  //    against the ACTUAL object size in storage (the client could have lied
  //    in the request), including the per-kind cap.
  router.post(
    "/:id/confirm",
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const row = await pool.query(SELECT_MEDIA, [id]);
      if (row.rows.length === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      const media = row.rows[0];
      if (media.owner_id !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this upload" });
      }

      let stat = null;
      try {
        stat = await internalClient.statObject(config.minio.bucket, media.storage_key);
      } catch {
        await pool.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [id]);
        return res.status(400).json({ error: "Upload not found in storage" });
      }

      const rule = ruleFor(media.content_type);
      const declaredSize = Number(media.size); // BIGINT arrives as a string
      // Hard cap first (security limit), then integrity: actual bytes must
      // match what the client declared.
      if (stat.size > rule.maxBytes) {
        await pool.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [id]);
        return res.status(400).json({
          error: "File too large",
          details: [{ path: "size", message: `actual size ${stat.size} exceeds the allowed limit` }],
        });
      }
      if (stat.size !== declaredSize) {
        await pool.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [id]);
        return res.status(400).json({
          error: "Size mismatch",
          details: [{ path: "size", message: `declared ${declaredSize} bytes, stored ${stat.size}` }],
        });
      }

      await pool.query(`UPDATE media SET status = 'ready' WHERE id = $1`, [id]);
      const updated = await pool.query(SELECT_MEDIA, [id]);
      return res.status(200).json({ status: "ready", media: toMedia(updated.rows[0]) });
    })
  );

  // Abort path: mark failed and best-effort delete the object.
  router.post(
    "/:id/cancel",
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const row = await pool.query(SELECT_MEDIA, [id]);
      if (row.rows.length === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      const media = row.rows[0];
      if (media.owner_id !== req.user.userId) {
        return res.status(403).json({ error: "You do not own this upload" });
      }
      await pool.query(`UPDATE media SET status = 'failed' WHERE id = $1`, [id]);
      internalClient.removeObject(config.minio.bucket, media.storage_key).catch(() => {});
      return res.status(200).json({ status: "failed" });
    })
  );

  // ------------------------------------------------------------- delivery

  // 3. Recipients fetch media through a signed, time-limited GET URL minted by
  //    this service ("CDN-style" delivery — see ARCHITECTURE.md). Any
  //    authenticated user may mint a URL: media ids are unguessable UUIDs and
  //    the URL itself expires. Restricting to conversation participants is a
  //    noted production gap (same section in ARCHITECTURE.md).
  router.get(
    "/:id/url",
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const row = await pool.query(SELECT_MEDIA, [id]);
      if (row.rows.length === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      const media = row.rows[0];
      if (media.status !== "ready") {
        return res.status(409).json({ error: "Media is not ready yet" });
      }
      const getUrl = await publicClient.presignedGetObject(
        config.minio.bucket,
        media.storage_key,
        MEDIA_URL_TTL_SECONDS
      );
      return res.status(200).json({
        media_id: media.id,
        get_url: getUrl,
        expires_in: MEDIA_URL_TTL_SECONDS,
      });
    })
  );

  // Metadata (filename, size, type) for renderers that don't have the message
  // envelope handy; same auth stance as the signed URL above.
  router.get(
    "/:id",
    validateParams(idParamSchema),
    asyncHandler(async (req, res) => {
      const row = await pool.query(SELECT_MEDIA, [req.params.id]);
      if (row.rows.length === 0) {
        return res.status(404).json({ error: "Media not found" });
      }
      return res.status(200).json({ media: toMedia(row.rows[0]) });
    })
  );

  return router;
}
