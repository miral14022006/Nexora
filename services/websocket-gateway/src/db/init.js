import { pool } from "./pool.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  avatar_url TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('DIRECT', 'GROUP')),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4-state delivery machine, forward-only by construction: the enum's declared
-- order IS the rank (PENDING=0 < SENT=1 < DELIVERED=2 < READ=3), so a guard of
-- status < $new in an UPDATE can never move a row backwards.
DO $$ BEGIN
  CREATE TYPE message_status_type AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- message_status is owned by delivery-service (Part 5); recreated here
-- idempotently so the reconnect-backlog flush works on a fresh DB.
CREATE TABLE IF NOT EXISTS message_status (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status message_status_type NOT NULL DEFAULT 'PENDING',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_status_user
  ON message_status (user_id, status);
`;

// Advisory lock so concurrent instances (horizontal scaling) don't race on
// identical CREATE TABLE statements; the loser of the pg_type race would
// crash the startup.
const MIGRATION_LOCK_ID = 7222024;

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
    // Existing databases created before read_at existed get the column now.
    await client.query(
      `ALTER TABLE message_status ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`
    );
    // Legacy TEXT status columns (with their text CHECK) are migrated to the
    // ordered enum so rank-guarded transitions work (idempotent; fresh DBs
    // already use the enum).
    await client.query(
      `ALTER TABLE message_status DROP CONSTRAINT IF EXISTS message_status_status_check`
    );
    await client.query(
      `ALTER TABLE message_status ALTER COLUMN status DROP DEFAULT`
    );
    await client.query(
      `ALTER TABLE message_status ALTER COLUMN status TYPE message_status_type USING status::message_status_type`
    );
    await client.query(
      `ALTER TABLE message_status ALTER COLUMN status SET DEFAULT 'PENDING'::message_status_type`
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
