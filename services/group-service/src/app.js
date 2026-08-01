import express from "express";
import { createGroupsRouter } from "./routes/groups.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createGroupsRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
