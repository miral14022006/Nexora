import { config } from "./config.js";
import { initDb } from "./db/init.js";
import { ensureBucket } from "./minio.js";
import { createApp } from "./app.js";

/**
 * Retries a startup step with backoff. On Render the whole fleet boots at
 * once and Postgres may not be reachable yet — retry instead of crash-looping.
 */
async function withRetry(fn, { attempts = 20, delayMs = 3000, label } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(
        `[${config.serviceName}] ${label ?? "startup"} failed (attempt ${attempt}/${attempts}):`,
        err.message
      );
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

/**
 * MinIO may lag the compose `minio: started` signal; retry bucket setup.
 * When object storage is not configured at all (no MINIO_INTERNAL_ENDPOINT),
 * setup is skipped so the service still boots (media routes return 503).
 */
async function ensureBucketWithRetry(attempts = 30, delayMs = 2000) {
  if (!config.minio.enabled) return;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await ensureBucket();
      return;
    } catch (err) {
      console.error(
        `[${config.serviceName}] minio not ready (attempt ${attempt}/${attempts}):`,
        err.message
      );
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await withRetry(initDb, { label: "database init" });
  await ensureBucketWithRetry();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[${config.serviceName}] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(`[${config.serviceName}] failed to start:`, err);
  process.exit(1);
});
