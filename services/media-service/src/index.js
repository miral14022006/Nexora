import { config } from "./config.js";
import { initDb } from "./db/init.js";
import { ensureBucket } from "./minio.js";
import { createApp } from "./app.js";

/** MinIO may lag the compose `minio: started` signal; retry bucket setup. */
async function ensureBucketWithRetry(attempts = 30, delayMs = 2000) {
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
  await initDb();
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
