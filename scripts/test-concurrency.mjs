import { randomUUID } from "crypto";

const API = "http://localhost:3000/api";

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function run() {
  const u1 = `u1_${Date.now()}`;
  const u2 = `u2_${Date.now()}`;

  const { user: user1, accessToken: t1 } = await post("/auth/signup", {
    username: u1,
    email: `${u1}@example.com`,
    password: "Password123!",
  });

  const { user: user2, accessToken: t2 } = await post("/auth/signup", {
    username: u2,
    email: `${u2}@example.com`,
    password: "Password123!",
  });

  console.log("Users created:", user1.id, user2.id);

  console.log("Firing 20 concurrent messages...");
  const promises = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      post("/messages", {
        type: "DIRECT",
        recipientId: user2.id,
        content: `Concurrent msg ${i}`,
        client_msg_id: randomUUID(),
      }, t1)
    );
  }

  const results = await Promise.all(promises);
  const sequences = results.map(r => parseInt(r.message.sequenceNo)).sort((a, b) => a - b);
  
  console.log("Assigned sequence numbers:", sequences);
  
  // Verify 1..20
  for (let i = 0; i < 20; i++) {
    if (sequences[i] !== i + 1) {
      console.error(`Concurrency test FAILED: expected ${i+1}, got ${sequences[i]}`);
      process.exit(1);
    }
  }
  console.log("Concurrency test PASSED! Exactly 1..20 with no gaps.");
}

run().catch(console.error);
