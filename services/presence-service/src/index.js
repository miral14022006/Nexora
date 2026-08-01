import express from "express";

const app = express();
const PORT = Number(process.env.PORT ?? 3006);

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`[${process.env.SERVICE_NAME ?? "presence-service"}] listening on port ${PORT}`);
});
