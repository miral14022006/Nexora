import { pool } from "./pool.js";

// The media table is the authoritative record of every upload, separate from
// the chat message that references it (the message only carries a small JSON
// envelope: media_id, filename, content_type, size).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'OTHER'
    CHECK (media_type IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'TEXT', 'OTHER')),
  size BIGINT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK (status IN ('uploading', 'ready', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS media_owner_idx ON media (owner_id, created_at DESC);
`;

const MIGRATION_LOCK_ID = 7222027;

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
    // Migration for existing databases: media_type is stored explicitly (not
    // re-inferred from content_type at render time). Backfill old rows from
    // their MIME; anything unknown becomes OTHER.
    await client.query(`
      ALTER TABLE media ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'OTHER'
        CHECK (media_type IN ('IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT', 'TEXT', 'OTHER'))
    `);
    await client.query(`
      UPDATE media SET media_type = CASE
        WHEN content_type LIKE 'image/%' THEN 'IMAGE'
        WHEN content_type LIKE 'video/%' THEN 'VIDEO'
        WHEN content_type LIKE 'audio/%' THEN 'AUDIO'
        WHEN content_type = 'application/pdf' THEN 'DOCUMENT'
        WHEN content_type LIKE 'text/%' OR content_type = 'application/json' THEN 'TEXT'
        ELSE 'OTHER'
      END
      WHERE media_type = 'OTHER'
    `);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
