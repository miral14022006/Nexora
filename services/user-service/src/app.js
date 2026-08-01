import express from "express";
import { createUsersRouter } from "./routes/users.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use(createUsersRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
}
