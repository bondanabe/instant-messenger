import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  primaryKey,
} from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────────────────────────
// IDENTITY — satu baris, milik pemilik device ini
// ─────────────────────────────────────────────────────────────────
export const identity = sqliteTable('identity', {
  id: text('id').primaryKey().default('self'),
  userId: text('user_id').notNull().unique(),        // UUID dibuat lokal
  displayName: text('display_name').notNull(),
  avatarData: blob('avatar_data'),                   // disimpan lokal
  privateKey: blob('private_key').notNull(),         // Ed25519 private key
  publicKey: blob('public_key').notNull(),           // Ed25519 public key
  deviceId: text('device_id').notNull().unique(),    // ID unik device ini
  createdAt: integer('created_at').notNull(),
})

// ─────────────────────────────────────────────────────────────────
// CONTACTS — hanya kontak yang sudah di-add user ini
// (tidak ada discovery global, kontak via QR Code / share link)
// ─────────────────────────────────────────────────────────────────
export const contacts = sqliteTable('contacts', {
  userId: text('user_id').primaryKey(),
  displayName: text('display_name').notNull(),
  publicKey: blob('public_key').notNull(),           // untuk verifikasi E2E
  avatarData: blob('avatar_data'),
  relayUserId: text('relay_user_id'),               // untuk routing via relay server
  lastSeenAt: integer('last_seen_at'),
  addedAt: integer('added_at').notNull(),
})

// ─────────────────────────────────────────────────────────────────
// CONVERSATIONS — percakapan 1-on-1 atau group
// ─────────────────────────────────────────────────────────────────
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),                       // UUID
  type: text('type', { enum: ['dm', 'group'] }).notNull(),
  name: text('name'),                                // hanya untuk group
  avatarData: blob('avatar_data'),
  lastMsgAt: integer('last_msg_at'),
  lastMsgPreview: text('last_msg_preview'),          // preview teks (max 80 char)
  unreadCount: integer('unread_count').notNull().default(0),
  isArchived: integer('is_archived', { mode: 'boolean' }).notNull().default(false),
  isMuted: integer('is_muted', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
})

// ─────────────────────────────────────────────────────────────────
// CONVERSATION MEMBERS — untuk group chat
// ─────────────────────────────────────────────────────────────────
export const conversationMembers = sqliteTable(
  'conversation_members',
  {
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull().default('member'),
    joinedAt: integer('joined_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.conversationId, t.userId] }),
  }),
)

// ─────────────────────────────────────────────────────────────────
// MESSAGES — semua pesan tersimpan lokal
// ─────────────────────────────────────────────────────────────────
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),                       // UUID dari pengirim
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(),
    type: text('type', {
      enum: ['text', 'image', 'video', 'audio', 'file', 'system'],
    })
      .notNull()
      .default('text'),
    content: text('content'),                          // teks ter-decrypt, simpan lokal
    status: text('status', {
      enum: ['pending', 'sent', 'delivered', 'read', 'failed'],
    })
      .notNull()
      .default('pending'),
    replyToId: text('reply_to_id'),                    // reply ke pesan lain
    isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),        // Lamport clock pengirim
    receivedAt: integer('received_at'),                // waktu device ini terima
    editedAt: integer('edited_at'),
  },
  (t) => ({
    convIdx: index('idx_messages_conv').on(t.conversationId, t.createdAt),
    senderIdx: index('idx_messages_sender').on(t.senderId),
  }),
)

// ─────────────────────────────────────────────────────────────────
// MEDIA — file/gambar tersimpan lokal di device
// ─────────────────────────────────────────────────────────────────
export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  mimeType: text('mime_type').notNull(),
  filePath: text('file_path'),                        // path lokal (file besar)
  blobData: blob('blob_data'),                        // inline (file < 512KB)
  sizeBytes: integer('size_bytes'),
  thumbnail: blob('thumbnail'),                       // preview 64x64
  transferStatus: text('transfer_status', {
    enum: ['pending', 'transferring', 'complete', 'failed'],
  })
    .notNull()
    .default('pending'),
})

// ─────────────────────────────────────────────────────────────────
// OUTBOX QUEUE — pesan pending, menggantikan server-side queue
// (disimpan lokal, dikirim otomatis saat ada koneksi)
// ─────────────────────────────────────────────────────────────────
export const outbox = sqliteTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id').notNull(),
    targetUserId: text('target_user_id').notNull(),
    encryptedPayload: blob('encrypted_payload').notNull(), // ciphertext siap kirim
    transport: text('transport', {
      enum: ['internet', 'lan', 'wifi_direct', 'bluetooth'],
    }),
    retryCount: integer('retry_count').notNull().default(0),
    nextRetryAt: integer('next_retry_at').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    retryIdx: index('idx_outbox_retry').on(t.nextRetryAt),
    targetIdx: index('idx_outbox_target').on(t.targetUserId),
  }),
)

// ─────────────────────────────────────────────────────────────────
// SIGNAL SESSIONS — Double Ratchet session state per kontak per device
// Berisi serialized RatchetState (JSON blob) — diupdate setiap pesan
// ─────────────────────────────────────────────────────────────────
export const signalSessions = sqliteTable(
  'signal_sessions',
  {
    userId: text('user_id').notNull(),
    deviceId: text('device_id').notNull().default('default'),
    /** Serialized RatchetState (JSON UTF-8 bytes) dari packages/crypto */
    sessionData: blob('session_data').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.deviceId] }),
  }),
)

// ─────────────────────────────────────────────────────────────────
// PREKEYS — prekey lokal kita sendiri (X25519)
// signed_prekey: diperbarui setiap ~7 hari, satu aktif sekaligus
// one_time_prekey: digunakan sekali lalu ditandai used_at
// ─────────────────────────────────────────────────────────────────
export const prekeys = sqliteTable(
  'prekeys',
  {
    id: integer('id').primaryKey(),
    keyType: text('key_type', {
      enum: ['signed_prekey', 'one_time_prekey'],
    }).notNull(),
    privateKey: blob('private_key').notNull(),  // X25519 private key (32B)
    publicKey: blob('public_key').notNull(),    // X25519 public key (32B)
    signature: blob('signature'),               // Ed25519 sig of publicKey (64B) — hanya signed_prekey
    usedAt: integer('used_at'),                 // null = tersedia; timestamp = sudah dikonsumsi
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    typeUsedIdx: index('idx_prekeys_type_used').on(t.keyType, t.usedAt),
  }),
)
