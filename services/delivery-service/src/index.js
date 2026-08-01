import { config } from "./config.js";
import { initDb } from "./db/init.js";
import { pool } from "./db/pool.js";
import { connectRedis, isOnline, publishDeliver, subscribeReceipts } from "./redis.js";
import { connectKafka, publishReceiptEvent, startMessageConsumer } from "./kafka.js";
import { handleMessageCreated, handleReceipt } from "./delivery.js";
import { createApp } from "./app.js";

const deliveryDeps = { pool, isOnline, publishDeliver, publishReceiptEvent };

/** Kafka may take a few seconds to be ready; retry instead of crashing. */
async function startConsumerWithRetry(attempts = 15, delayMs = 5000) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const consumer = await startMessageConsumer((event) =>
        handleMessageCreated(event, deliveryDeps)
      );
      console.log(
        `[${config.serviceName}] consuming ${config.messageTopic} (group ${config.consumerGroupId})`
      );
      return consumer;
    } catch (err) {
      console.error(
        `[${config.serviceName}] consumer connect failed (attempt ${attempt}/${attempts}):`,
        err.message
      );
      if (attempt === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  await initDb();
  await connectRedis();
  await connectKafka();

  await subscribeReceipts((receipt) => {
    handleReceipt(receipt, deliveryDeps).catch((err) =>
      console.error(`[${config.serviceName}] receipt handler error:`, err.message)
    );
  });
  console.log(
    `[${config.serviceName}] listening for receipts on ${config.receiptChannel}`
  );

  await startConsumerWithRetry();

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[${config.serviceName}] listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(`[${config.serviceName}] failed to start:`, err);
  process.exit(1);
});
