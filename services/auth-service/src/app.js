import express from "express";
import authRouter from "./routes/auth.js";

export function createApp() {
  const app = express();

  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/auth", authRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use((err, _req, res, _next) => {
    console.error("[auth-service] unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
