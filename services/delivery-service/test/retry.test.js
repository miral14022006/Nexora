import { describe, expect, it } from "vitest";
import { processWithRetry } from "../src/kafka.js";

// Deterministic, timer-free settings: 1ms base delay, no jitter, noop sleep.
const fast = {
  maxAttempts: 5,
  baseDelayMs: 1,
  jitterMaxMs: 0,
  sleep: async () => {},
};

const event = { eventType: "message.created", messageId: crypto.randomUUID() };

describe("processWithRetry (consumer retry + DLQ)", () => {
  it("recovers on the first attempt without touching the DLQ", async () => {
    const dlq = [];
    await processWithRetry(event, async () => {}, {
      ...fast,
      publishToDlq: async (p) => dlq.push(p),
    });
    expect(dlq).toHaveLength(0);
  });

  it("retries with exponential backoff until the handler succeeds", async () => {
    let calls = 0;
    const sleeps = [];
    await processWithRetry(
      event,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("boom");
      },
      {
        ...fast,
        sleep: async (ms) => sleeps.push(ms),
        publishToDlq: async () => {
          throw new Error("must not be called");
        },
      }
    );
    expect(calls).toBe(3);
    // Backoff schedule: 1ms after attempt 1, 2ms after attempt 2 (2^n growth).
    expect(sleeps).toEqual([1, 2]);
  });

  it("capped backoff: the 2^n exponent stops growing at 8s", async () => {
    const sleeps = [];
    const handler = async () => {
      throw new Error("always fails");
    };
    await processWithRetry(
      event,
      handler,
      {
        ...fast,
        maxAttempts: 7,
        sleep: async (ms) => sleeps.push(ms),
        publishToDlq: async () => {},
      }
    );
    // 1, 2, 4, 8, 8, 8 — the exponent is capped at 2^3.
    expect(sleeps).toEqual([1, 2, 4, 8, 8, 8]);
  });

  it("exhausts maxAttempts and publishes the event to the DLQ with error context", async () => {
    const dlq = [];
    await processWithRetry(
      event,
      async () => {
        throw new Error("redis unreachable");
      },
      { ...fast, publishToDlq: async (p) => dlq.push(p) }
    );

    expect(dlq).toHaveLength(1);
    expect(dlq[0].eventType).toBe("dlq");
    expect(dlq[0].originalEvent.messageId).toBe(event.messageId);
    expect(dlq[0].error).toBe("redis unreachable");
    expect(dlq[0].attempts).toBe(5);
    expect(dlq[0].consumer).toBe("delivery-service");
    expect(dlq[0].at).toBeTruthy();
  });

  it("never throws: a DLQ publish failure is logged, not fatal", async () => {
    const handler = async () => {
      throw new Error("boom");
    };
    await expect(
      processWithRetry(event, handler, {
        ...fast,
        publishToDlq: async () => {
          throw new Error("kafka down too");
        },
      })
    ).resolves.toBeUndefined();
  });
});
