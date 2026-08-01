import express from "express";
import { createMediaRouter } from "./routes/media.js";

export function createApp() {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  // Mounted at /media to match the gateway's prefix stripping:
  // /api/media/upload-url → media-service /media/upload-url.
  app.use("/media", createMediaRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    console.error("[media-service] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
