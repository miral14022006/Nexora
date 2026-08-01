import { createApp } from "./app.js";
import { config } from "./config.js";
import { initDb } from "./db/init.js";
import { connectKafka } from "./kafka.js";
import { connectRedis } from "./redis.js";

async function main() {
  await initDb();
  await connectKafka();
  await connectRedis();
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[${config.serviceName}] listening on port ${config.port}`);
  });
}

main().catch((err) => {
  console.error(`[${config.serviceName}] failed to start:`, err);
  process.exit(1);
});
