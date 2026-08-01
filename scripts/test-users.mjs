import { randomUUID } from "crypto";

const API = "http://localhost:3000/api";

async function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function get(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function patch(path, body, token) {
  const res = await fetch(`${API}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`PATCH ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function run() {
  const u1 = `u1_${Date.now()}`;
  const { user: user1, accessToken: t1 } = await post("/auth/signup", {
    username: u1, email: `${u1}@example.com`, password: "Password123!"
  });

  console.log("Testing GET /users/me...");
  const meRes = await get("/users/me", t1);
  if (!meRes.user.email || meRes.user.password_hash) throw new Error("GET /users/me leaked/missing fields");
  console.log("GET /users/me OK");

  console.log("Testing GET /users/:id...");
  const idRes = await get(`/users/${user1.id}`, t1);
  if (idRes.user.email || idRes.user.password_hash) throw new Error("GET /users/:id leaked sensitive fields");
  console.log("GET /users/:id OK");

  console.log("Testing PATCH /users/me...");
  const newName = `u1_patched_${Date.now()}`;
  const patchRes = await patch("/users/me", { username: newName }, t1);
  if (patchRes.user.username !== newName) throw new Error("PATCH failed to update username");
  
  const verify = await get("/users/me", t1);
  if (verify.user.username !== newName) throw new Error("PATCH update didn't persist");
  console.log("PATCH /users/me OK");
  console.log("Users API Test Passed!");
}

run().catch(console.error);
