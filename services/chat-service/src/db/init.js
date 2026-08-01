import { pool } from "./pool.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- groups / group_members are owned by group-service; recreated here
-- idempotently so the GROUP-message membership check works on a fresh DB.
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

CREATE INDEX IF NOT EXISTS idx_group_members_user_id ON group_members(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('DIRECT', 'GROUP')),
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES users(id) ON DELETE CASCADE,
  group_id UUID REFERENCES groups(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  client_msg_id UUID, -- client-generated idempotency key (nullable: server generates)
  sequence_no BIGSERIAL, -- global monotonic ingest order
  membership_version INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (type = 'DIRECT' OR group_id IS NOT NULL),
  UNIQUE (sender_id, client_msg_id)
);

-- Migration for existing databases (idempotent; fresh DBs get the columns above).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS membership_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS membership_version INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_msg_id UUID;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sequence_no BIGSERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_sender_client_msg
  ON messages (sender_id, client_msg_id);

CREATE INDEX IF NOT EXISTS idx_messages_direct ON messages (sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages (group_id, created_at DESC);

-- 4-state delivery machine, forward-only by construction: the enum's declared
-- order IS the rank (PENDING=0 < SENT=1 < DELIVERED=2 < READ=3), so a guard of
-- status < $new in an UPDATE can never move a row backwards.
DO $$ BEGIN
  CREATE TYPE message_status_type AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- message_status is owned by delivery-service; recreated here idempotently
-- so the read-receipt endpoints work on a fresh DB.
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

CREATE TABLE IF NOT EXISTS conversation_sequences (
  conversation_id TEXT PRIMARY KEY,
  next_seq BIGINT NOT NULL DEFAULT 1
);
`;

export async function initDb() {
  await pool.query(SCHEMA);
  // Existing databases created before read_at existed get the column now.
  await pool.query(
    `ALTER TABLE message_status ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`
  );
  // Legacy TEXT status columns (with their text CHECK) are migrated to the
  // ordered enum so rank-guarded transitions work (idempotent; fresh DBs
  // already use the enum).
  await pool.query(
    `ALTER TABLE message_status DROP CONSTRAINT IF EXISTS message_status_status_check`
  );
  await pool.query(
    `ALTER TABLE message_status ALTER COLUMN status DROP DEFAULT`
  );
  await pool.query(
    `ALTER TABLE message_status ALTER COLUMN status TYPE message_status_type USING status::message_status_type`
  );
  await pool.query(
    `ALTER TABLE message_status ALTER COLUMN status SET DEFAULT 'PENDING'::message_status_type`
  );

  // Per-conversation sequence migration
  const hasSeqTable = await pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'conversation_sequences'`);
  if (hasSeqTable.rows.length > 0) {
    // Drop the global BIGSERIAL default if it exists
    await pool.query(`ALTER TABLE messages ALTER COLUMN sequence_no DROP DEFAULT`);

    // Only backfill if conversation_sequences is empty (i.e. fresh table for existing messages)
    const seqCount = await pool.query(`SELECT 1 FROM conversation_sequences LIMIT 1`);
    if (seqCount.rows.length === 0) {
      await pool.query(`
        WITH ranked AS (
          SELECT id,
                 (CASE WHEN type = 'GROUP' THEN 'g:' || group_id
                       ELSE 'd:' || LEAST(sender_id, recipient_id) || '_' || GREATEST(sender_id, recipient_id)
                  END) as conv_id,
                 row_number() OVER (
                    PARTITION BY
                      CASE WHEN type = 'GROUP' THEN 'g:' || group_id
                           ELSE 'd:' || LEAST(sender_id, recipient_id) || '_' || GREATEST(sender_id, recipient_id)
                      END
                    ORDER BY created_at ASC, id ASC
                 ) as new_seq
          FROM messages
        )
        UPDATE messages m
        SET sequence_no = r.new_seq
        FROM ranked r
        WHERE m.id = r.id AND m.sequence_no != r.new_seq
      `);

      await pool.query(`
        INSERT INTO conversation_sequences (conversation_id, next_seq)
        SELECT 
          (CASE WHEN type = 'GROUP' THEN 'g:' || group_id
                ELSE 'd:' || LEAST(sender_id, recipient_id) || '_' || GREATEST(sender_id, recipient_id)
           END) as conv_id,
          COALESCE(MAX(sequence_no), 0) + 1
        FROM messages
        GROUP BY conv_id
        ON CONFLICT (conversation_id) DO UPDATE SET next_seq = EXCLUDED.next_seq
      `);
    }
  }
}
