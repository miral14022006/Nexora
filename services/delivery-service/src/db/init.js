import { pool } from "./pool.js";

// message_status is the delivery-service's system of record for delivery
// state; users / messages / group_members are owned elsewhere (auth, chat,
// group services) but recreated idempotently so a fresh DB boots correctly.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('DIRECT', 'GROUP')),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  membership_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type = 'DIRECT' OR group_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  avatar_url TEXT,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_status (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'DELIVERED', 'READ')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_status_user
  ON message_status (user_id, status);
`;

// Advisory lock so concurrent instances (horizontal scaling) don't race on
// identical CREATE TABLE statements (see websocket-gateway initDb).
const MIGRATION_LOCK_ID = 7222025;

export async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
    // Existing databases created before read_at existed get the column now.
    await client.query(
      `ALTER TABLE message_status ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`
    );
    await client.query(
      `ALTER TABLE groups ADD COLUMN IF NOT EXISTS membership_version INTEGER NOT NULL DEFAULT 1`
    );
    await client.query(
      `ALTER TABLE messages ADD COLUMN IF NOT EXISTS membership_version INTEGER`
    );
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
