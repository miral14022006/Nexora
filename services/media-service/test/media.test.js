import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { initDb } from "../src/db/init.js";
import { pool } from "../src/db/pool.js";
import { internalClient, ensureBucket } from "../src/minio.js";
import { config } from "../src/config.js";

const SECRET = "dev-internal-secret";
const headers = (userId, username = "tester") => ({
  "X-Nexora-Internal-Secret": SECRET,
  "X-Nexora-User-Id": userId,
  "X-Nexora-Username": username,
});

const app = createApp();

let alice, bob;

beforeAll(async () => {
  await initDb();
  await ensureBucket();

  const salt = crypto.randomUUID().slice(0, 8);
  const users = await Promise.all(
    ["alice", "bob"].map((name, i) =>
      pool.query(
        `INSERT INTO users (username, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id, username`,
        [`${name}_${salt}`, `${name}_${salt}@nexora.dev`, "hash"]
      )
    )
  );
  alice = users[0].rows[0];
  bob = users[1].rows[0];
});

afterAll(async () => {
  const rows = await pool.query(`SELECT id, storage_key FROM media WHERE owner_id = ANY($1)`, [
    [alice.id, bob.id],
  ]);
  for (const row of rows.rows) {
    await internalClient.removeObject(config.minio.bucket, row.storage_key).catch(() => {});
  }
  await pool.query(`DELETE FROM media WHERE owner_id = ANY($1)`, [[alice.id, bob.id]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1)`, [[alice.id, bob.id]]);
  await pool.end();
});

/** The presigned URL points at the public endpoint; from inside the test
 *  container MinIO is only reachable via its internal DNS name. */
function internalize(url) {
  return url.replace(config.minio.publicEndPoint, config.minio.endPoint);
}

async function uploadObject(uploadUrl, bytes) {
  const res = await fetch(internalize(uploadUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
  });
  return res.status;
}

function pngBytes(n = 512) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(n - 8, 0xab),
  ]);
}

describe("POST /upload-url", () => {
  it("rejects requests without the gateway trust headers", async () => {
    const res = await request(app).post("/media/upload-url").send({});
    expect(res.status).toBe(403);
  });

  it("rejects unsupported content types before any bytes move", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "evil.exe", content_type: "application/x-msdownload", size: 100 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Unsupported media type");
  });

  it("rejects oversized files at issuance", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "huge.jpg", content_type: "image/jpeg", size: 16 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("File too large");
  });

  it("accepts a jpeg up to the 15MB image cap", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "big.png", content_type: "image/png", size: 15 * 1024 * 1024 });
    expect(res.status).toBe(201);
  });

  it("accepts mp4/mov/webm up to the 100MB video cap and records VIDEO type", async () => {
    for (const type of ["video/mp4", "video/mov", "video/webm"]) {
      const res = await request(app)
        .post("/media/upload-url")
        .set(headers(alice.id))
        .send({ filename: `clip.${type.split("/")[1]}`, content_type: type, size: 100 * 1024 * 1024 });
      expect(res.status).toBe(201);
      const row = await pool.query(`SELECT media_type FROM media WHERE id = $1`, [res.body.upload_id]);
      expect(row.rows[0].media_type).toBe("VIDEO");
    }
  });

  it("rejects videos over the 100MB cap", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "too-big.mov", content_type: "video/mov", size: 101 * 1024 * 1024 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("File too large");
  });

  it("records the stored media type explicitly (not re-inferred)", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "shot.png", content_type: "image/png", size: 512 });
    const row = await pool.query(`SELECT media_type FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].media_type).toBe("IMAGE");
  });

  it("rejects negative/zero sizes", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "x.jpg", content_type: "image/jpeg", size: 0 });
    expect(res.status).toBe(400);
  });

  it("returns a pre-signed PUT URL and records the upload as 'uploading'", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "hello.png", content_type: "image/png", size: 512 });
    expect(res.status).toBe(201);
    expect(res.body.upload_id).toBeTruthy();
    expect(res.body.upload_url).toContain(config.minio.publicEndPoint);
    expect(res.body.upload_url).toContain("X-Amz-Signature");
    expect(res.body.expires_in).toBe(60);

    const row = await pool.query(`SELECT * FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("uploading");
    expect(row.rows[0].owner_id).toBe(alice.id);
    expect(row.rows[0].storage_key.startsWith(`${alice.id}/`)).toBe(true);
    expect(row.rows[0].filename).toBe("hello.png");
    return res.body.upload_id;
  });

  it("sanitizes filenames (no path traversal)", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "../../etc/passwd.png", content_type: "image/png", size: 10 });
    expect(res.status).toBe(201);
    expect(res.body.upload_id).toBeTruthy();
    const row = await pool.query(`SELECT filename, storage_key FROM media WHERE id = $1`, [
      res.body.upload_id,
    ]);
    expect(row.rows[0].filename).not.toContain("..");
    expect(row.rows[0].storage_key).not.toContain("..");
  });
});

describe("confirm / cancel", () => {
  it("marks an upload failed when the object never arrived", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "ghost.png", content_type: "image/png", size: 512 });
    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(alice.id));
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toBe("Upload not found in storage");
    const row = await pool.query(`SELECT status FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("confirms a real upload and marks it ready", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "pic.png", content_type: "image/png", size: 512 });
    expect(await uploadObject(res.body.upload_url, pngBytes(512))).toBe(200);

    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(alice.id));
    expect(confirm.status).toBe(200);
    expect(confirm.body.status).toBe("ready");

    const row = await pool.query(`SELECT status FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("ready");
  });

  it("rejects a confirm from a different user", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "mine.png", content_type: "image/png", size: 512 });
    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(bob.id));
    expect(confirm.status).toBe(403);
  });

  it("rejects a size mismatch between the claim and the actual object", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "liar.png", content_type: "image/png", size: 512 });
    await uploadObject(res.body.upload_url, pngBytes(1024)); // bigger than claimed
    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(alice.id));
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toBe("Size mismatch");
    const row = await pool.query(`SELECT status FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("rejects an object that exceeds the size cap even if the claim was small", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "sneaky.txt", content_type: "text/plain", size: 10 });
    await uploadObject(res.body.upload_url, Buffer.alloc(3 * 1024 * 1024, 0x61));
    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(alice.id));
    expect(confirm.status).toBe(400);
    expect(confirm.body.error).toBe("File too large");
    const row = await pool.query(`SELECT status FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("cancel marks the upload failed", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "bye.png", content_type: "image/png", size: 512 });
    const cancel = await request(app)
      .post(`/media/${res.body.upload_id}/cancel`)
      .set(headers(alice.id));
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("failed");
    const row = await pool.query(`SELECT status FROM media WHERE id = $1`, [res.body.upload_id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("404s on unknown ids", async () => {
    const unknown = crypto.randomUUID();
    expect((await request(app).post(`/media/${unknown}/confirm`).set(headers(alice.id))).status).toBe(404);
    expect((await request(app).post(`/media/${unknown}/cancel`).set(headers(alice.id))).status).toBe(404);
  });
});

describe("signed delivery URLs", () => {
  async function makeReady() {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "shot.png", content_type: "image/png", size: 512 });
    await uploadObject(res.body.upload_url, pngBytes(512));
    const confirm = await request(app)
      .post(`/media/${res.body.upload_id}/confirm`)
      .set(headers(alice.id));
    expect(confirm.status).toBe(200);
    return res.body.upload_id;
  }

  it("refuses to mint a URL for media that is not ready", async () => {
    const res = await request(app)
      .post("/media/upload-url")
      .set(headers(alice.id))
      .send({ filename: "pending.png", content_type: "image/png", size: 512 });
    const url = await request(app).get(`/media/${res.body.upload_id}/url`).set(headers(alice.id));
    expect(url.status).toBe(409);
  });

  it("mints a time-limited signed GET URL for ready media", async () => {
    const id = await makeReady();
    const url = await request(app).get(`/media/${id}/url`).set(headers(alice.id));
    expect(url.status).toBe(200);
    expect(url.body.media_id).toBe(id);
    expect(url.body.get_url).toContain(config.minio.publicEndPoint);
    expect(url.body.get_url).toContain("X-Amz-Signature");
    expect(url.body.expires_in).toBe(600);
  });

  it("lets any authenticated user mint the URL (documented MVP stance)", async () => {
    const id = await makeReady();
    const url = await request(app).get(`/media/${id}/url`).set(headers(bob.id));
    expect(url.status).toBe(200);
    expect(url.body.get_url).toContain("X-Amz-Signature");
  });

  it("the signed GET URL actually returns the stored bytes", async () => {
    const id = await makeReady();
    const url = await request(app).get(`/media/${id}/url`).set(headers(bob.id));
    const get = await fetch(internalize(url.body.get_url));
    expect(get.status).toBe(200);
    const body = Buffer.from(await get.arrayBuffer());
    expect(body).toEqual(pngBytes(512));
  });

  it("returns metadata via GET /:id", async () => {
    const id = await makeReady();
    const res = await request(app).get(`/media/${id}`).set(headers(bob.id));
    expect(res.status).toBe(200);
    expect(res.body.media).toMatchObject({
      id,
      filename: "shot.png",
      contentType: "image/png",
      mediaType: "IMAGE",
      size: 512,
      status: "ready",
      ownerId: alice.id,
    });
  });
});
