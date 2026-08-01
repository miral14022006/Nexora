#!/usr/bin/env node
/**
 * Inspects the dead-letter queue (message-events-dlq).
 *
 * Usage:
 *   node scripts/dlq-inspect.mjs                # last 10 DLQ messages
 *   node scripts/dlq-inspect.mjs --count 25     # last 25
 *   node scripts/dlq-inspect.mjs --follow       # stream new messages until Ctrl-C
 *
 * Env: KAFKA_BROKERS (default localhost:9092), KAFKA_DLQ_TOPIC
 *
 * NOTE: the compose Kafka advertises its in-network name (kafka:9092), so a
 * host-side run resolves the initial broker but then gets redirected to a name
 * the host can't resolve. Run the script inside the compose network instead
 * (copy it to a tmp dir first — iCloud-synced paths can't be bind-mounted):
 *   cp scripts/dlq-inspect.mjs /tmp/dlq/ && cd /tmp/dlq
 *   docker run --rm --network nexora_default -e KAFKA_BROKERS=kafka:9092 \
 *     -v "$PWD:/app" -w /app node:22-alpine \
 *     sh -c 'npm i --no-save kafkajs >/dev/null 2>&1 && node dlq-inspect.mjs --count 5'
 * or read the raw payloads with the bundled Kafka CLI:
 *   docker compose exec kafka sh -c 'export PATH=/opt/kafka/bin:$PATH; \
 *     kafka-console-consumer.sh --bootstrap-server kafka:9092 \
 *     --topic message-events-dlq --from-beginning --max-messages 5'
 */
import { Kafka } from "kafkajs";

const args = process.argv.slice(2);
const countArg = args.indexOf("--count");
const count = countArg !== -1 ? Number(args[countArg + 1]) : 10;
const follow = args.includes("--follow");

const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);
const topic = process.env.KAFKA_DLQ_TOPIC ?? "message-events-dlq";

const kafka = new Kafka({
  clientId: "nexora-dlq-inspect",
  brokers,
});

const groupId = `nexora-dlq-inspect-${process.pid}-${Date.now()}`;

async function main() {
  const admin = kafka.admin();
  await admin.connect();
  const offsets = await admin.fetchTopicOffsets(topic);
  await admin.disconnect();

  if (offsets.length === 0 || offsets.every((o) => Number(o.offset) === 0)) {
    console.log(`[dlq] ${topic}: empty (no dead letters)`);
    return;
  }

  const partition = offsets[0];
  const end = Number(partition.offset);
  const start = follow ? end : Math.max(0, end - count);
  console.log(
    `[dlq] ${topic} (partition ${partition.partition}): ${end} message(s) total, ` +
      (follow ? "following for new messages" : `showing last ${Math.min(count, end)}`)
  );

  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });

  let seen = 0;
  let exitTimer = follow
    ? null
    : setTimeout(() => {
        console.log(`[dlq] read ${seen} message(s); exiting`);
        process.exit(0);
      }, 1500);

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        const p = JSON.parse(message.value.toString());
        const original = p.originalEvent ?? {};
        const content = original.content
          ? ` content="${String(original.content).slice(0, 60)}"`
          : "";
        console.log(
          `\n--- DLQ message @ offset ${message.offset} (${p.at}) ---` +
            `\n  attempts : ${p.attempts}` +
            `\n  error    : ${p.error}` +
            `\n  event    : ${p.eventType} messageId=${original.messageId ?? "?"} type=${original.type ?? "?"}${content}` +
            (p.consumer ? `\n  consumer : ${p.consumer}` : "")
        );
      } catch {
        console.log(`\n--- DLQ message @ offset ${message.offset} (malformed payload) ---`);
      }
      seen += 1;
      if (!follow && seen >= count) {
        console.log(`[dlq] read ${seen} message(s); exiting`);
        process.exit(0);
      }
    },
  });
  // seek after run() so the consumer group exists first
  await consumer.seek({ topic, partition: partition.partition, offset: start });
}

main().catch((err) => {
  console.error("[dlq] inspection failed:", err.message);
  process.exit(1);
});
