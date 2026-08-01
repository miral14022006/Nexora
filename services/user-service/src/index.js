import { createApp } from "./app.js";
import { config } from "./config.js";
import { initDb } from "./db/init.js";

async function main() {
  await initDb();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[${config.serviceName}] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(`[${config.serviceName}] failed to start:`, err);
  process.exit(1);
});
