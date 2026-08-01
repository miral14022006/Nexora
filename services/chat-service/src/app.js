import express from "express";
import { createMessagesRouter } from "./routes/messages.js";

export function createApp({ publishMessageEvent, publishReadReceipt } = {}) {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createMessagesRouter({ publishMessageEvent, publishReadReceipt }));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    console.error("[chat-service] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
