import { config } from "./config.js";
import { initDb } from "./db/init.js";
import { connectRedis } from "./redis.js";
import { createServer } from "./server.js";

async function main() {
  await initDb();
  await connectRedis();

  const httpServer = createServer();
  httpServer.listen(config.port, () => {
    console.log(
      `[${config.serviceName}] listening on :${config.port} (WS path ${config.wsPath})`
    );
  });
}

main().catch((err) => {
  console.error(`[${config.serviceName}] failed to start:`, err);
  process.exit(1);
});
