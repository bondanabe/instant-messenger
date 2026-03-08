import type { DB } from '@op-engineering/op-sqlite'

// ─────────────────────────────────────────────────────────────────
// MIGRATIONS — dijalankan berurutan, tidak dapat diulang
// Tambahkan migration baru di akhir array MIGRATIONS
// JANGAN ubah migration yang sudah ada
// ─────────────────────────────────────────────────────────────────

const MIGRATIONS: string[] = [
  // Migration 001 — schema awal
  `
  CREATE TABLE IF NOT EXISTS identity (
    id           TEXT PRIMARY KEY DEFAULT 'self',
    user_id      TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    avatar_data  BLOB,
    private_key  BLOB NOT NULL,
    public_key   BLOB NOT NULL,
    device_id    TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    user_id        TEXT PRIMARY KEY,
    display_name   TEXT NOT NULL,
    public_key     BLOB NOT NULL,
    avatar_data    BLOB,
    relay_user_id  TEXT,
    last_seen_at   INTEGER,
    added_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id               TEXT PRIMARY KEY,
    type             TEXT NOT NULL CHECK(type IN ('dm', 'group')),
    name             TEXT,
    avatar_data      BLOB,
    last_msg_at      INTEGER,
    last_msg_preview TEXT,
    unread_count     INTEGER NOT NULL DEFAULT 0,
    is_archived      INTEGER NOT NULL DEFAULT 0,
    is_muted         INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
    joined_at       INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL,
    type            TEXT NOT NULL DEFAULT 'text'
                    CHECK(type IN ('text','image','video','audio','file','system')),
    content         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending','sent','delivered','read','failed')),
    reply_to_id     TEXT,
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    received_at     INTEGER,
    edited_at       INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv
    ON messages(conversation_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_sender
    ON messages(sender_id);

  CREATE TABLE IF NOT EXISTS media (
    id              TEXT PRIMARY KEY,
    message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    mime_type       TEXT NOT NULL,
    file_path       TEXT,
    blob_data       BLOB,
    size_bytes      INTEGER,
    thumbnail       BLOB,
    transfer_status TEXT NOT NULL DEFAULT 'pending'
                    CHECK(transfer_status IN ('pending','transferring','complete','failed'))
  );

  CREATE TABLE IF NOT EXISTS outbox (
    id                TEXT PRIMARY KEY,
    message_id        TEXT NOT NULL,
    target_user_id    TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    transport         TEXT CHECK(transport IN ('internet','lan','wifi_direct','bluetooth')),
    retry_count       INTEGER NOT NULL DEFAULT 0,
    next_retry_at     INTEGER NOT NULL,
    created_at        INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_outbox_retry
    ON outbox(next_retry_at);

  CREATE INDEX IF NOT EXISTS idx_outbox_target
    ON outbox(target_user_id);

  CREATE TABLE IF NOT EXISTS signal_sessions (
    user_id      TEXT NOT NULL,
    device_id    TEXT NOT NULL DEFAULT 'default',
    session_data BLOB NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS _migrations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    INTEGER NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  );
  `,

  // Migration 002 — prekeys untuk Signal Protocol (Tahap 2)
  `
  CREATE TABLE IF NOT EXISTS prekeys (
    id          INTEGER PRIMARY KEY,
    key_type    TEXT NOT NULL CHECK(key_type IN ('signed_prekey', 'one_time_prekey')),
    private_key BLOB NOT NULL,
    public_key  BLOB NOT NULL,
    signature   BLOB,
    used_at     INTEGER,
    created_at  INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_prekeys_type_used
    ON prekeys(key_type, used_at);
  `,
]

export async function runMigrations(db: DB): Promise<void> {
  // Buat tabel migrations tracker jika belum ada
  db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      version    INTEGER NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    )
  `)

  // Cek versi terakhir yang sudah diaplikasikan
  const result = db.execute('SELECT MAX(version) as v FROM _migrations')
  const lastVersion: number = (result.rows?.[0] as { v: number | null } | undefined)?.v ?? -1

  // Jalankan migration yang belum diaplikasikan
  for (let i = lastVersion + 1; i < MIGRATIONS.length; i++) {
    const sql = MIGRATIONS[i]
    if (!sql) continue

    db.transaction(() => {
      db.execute(sql)
      db.execute('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [
        i,
        Date.now(),
      ])
    })

    console.log(`[db] Migration ${i} applied`)
  }
}
