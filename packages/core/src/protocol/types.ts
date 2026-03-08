// ─────────────────────────────────────────────────────────────────
// WIRE PROTOCOL — format pesan yang dikirim antar device
// ─────────────────────────────────────────────────────────────────

/** Tipe konten pesan */
export type MessageContentType = 'text' | 'image' | 'video' | 'audio' | 'file' | 'system'

/** Status pengiriman pesan */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed'

/** Mode transport yang tersedia */
export type TransportMode = 'internet' | 'lan' | 'wifi_direct' | 'bluetooth' | 'offline'

// ─────────────────────────────────────────────────────────────────
// WIRE MESSAGE — payload yang dikirim lewat jaringan
// Semua field ini akan di-wrap dalam ciphertext E2EE (Tahap 2)
// ─────────────────────────────────────────────────────────────────

export interface WireMessage {
  /** UUID unik pesan, dibuat oleh pengirim */
  id: string
  /** UUID percakapan */
  conversationId: string
  /** userId pengirim */
  senderId: string
  /** Tipe konten */
  type: MessageContentType
  /** Isi pesan (teks), atau null untuk media */
  content: string | null
  /** Lamport clock untuk ordering */
  createdAt: number
  /** Reply ke pesan lain (opsional) */
  replyToId?: string
  /** Metadata media attachment (opsional) */
  mediaMeta?: WireMediaMeta
}

export interface WireMediaMeta {
  id: string
  mimeType: string
  sizeBytes: number
  /** Thumbnail kecil base64 — dikirim bersama pesan, file asli transfer terpisah */
  thumbnailBase64?: string
}

// ─────────────────────────────────────────────────────────────────
// RELAY PROTOCOL — format socket.io event antar client ↔ relay
// ─────────────────────────────────────────────────────────────────

/** Payload untuk registrasi ke relay server */
export interface RelayRegisterPayload {
  userId: string
  publicKey: string   // base64 encoded Ed25519 public key
  deviceId: string
}

/** Payload envelope untuk pengiriman via relay */
export interface RelayEnvelope {
  targetUserId: string
  messageId: string
  /** Ciphertext base64 (E2EE) — server tidak bisa membaca isi */
  encryptedPayload: string
}

/** Response dari relay server setelah forward */
export interface RelayAck {
  ok: boolean
  delivered: boolean
  reason?: 'target_offline' | 'rate_limited' | 'payload_too_large' | 'not_registered'
  error?: string
}

/** Event typing indicator */
export interface TypingEvent {
  fromUserId: string
  isTyping: boolean
}

/** Event read receipt */
export interface ReadReceiptEvent {
  fromUserId: string
  messageId: string
}

// ─────────────────────────────────────────────────────────────────
// E2EE WIRE TYPES — format yang dikirim via relay/LAN/BLE
// Header (x3dh, header) tidak terenkripsi — diperlukan untuk dekripsi
// Hanya `ciphertext` yang terenkripsi AES-256-GCM
// ─────────────────────────────────────────────────────────────────

/**
 * PreKey bundle dalam format wire (semua binary → base64 string).
 * Dipublikasikan ke relay server saat connect agar kontak bisa kirim pesan pertama.
 */
export interface PreKeyBundleWire {
  userId: string
  deviceId: string
  /** base64 Ed25519 identity public key (32 bytes) */
  identityKey: string
  /** base64 X25519 identity key (32 bytes) — diderivasi dari Ed25519 */
  identityKeyX25519: string
  signedPreKeyId: number
  /** base64 X25519 signed prekey public key (32 bytes) */
  signedPreKey: string
  /** base64 Ed25519 signature dari signedPreKey (64 bytes) */
  signedPreKeySignature: string
  oneTimePreKeyId?: number
  /** base64 X25519 one-time prekey public key (32 bytes) */
  oneTimePreKey?: string
}

/** X3DH init header — dikirim hanya pada pesan pertama ke sesi baru */
export interface E2EEX3DHHeader {
  /** base64 Ed25519 identity public key pengirim */
  senderIdentityKey: string
  /** base64 X25519 identity public key pengirim */
  senderIdentityKeyX25519: string
  /** base64 X25519 ephemeral public key pengirim */
  ephemeralPublicKey: string
  signedPreKeyId: number
  oneTimePreKeyId?: number
}

/** Double Ratchet message header — dikirim di setiap pesan (plaintext) */
export interface E2EERatchetHeader {
  /** base64 X25519 DH ratchet public key pengirim */
  dhPublicKey: string
  prevChainCount: number
  messageNumber: number
}

/**
 * E2EE payload lengkap — yang masuk ke RelayEnvelope.encryptedPayload (base64 JSON).
 * Server melihat header ratchet (public keys, counters) tapi TIDAK bisa membaca isi pesan.
 */
export interface E2EEPayload {
  /** Hanya ada pada pesan pertama di sesi baru */
  x3dh?: E2EEX3DHHeader
  /** Double Ratchet header */
  header: E2EERatchetHeader
  /** base64 AES-256-GCM(WireMessage JSON) termasuk 16B auth tag */
  ciphertext: string
}

// ─────────────────────────────────────────────────────────────────
// CONTACT CARD — dibagikan saat add kontak (via QR / share link)
// ─────────────────────────────────────────────────────────────────

export interface ContactCard {
  userId: string
  displayName: string
  publicKey: string   // base64 Ed25519 public key
  deviceId: string
  /** URL relay server user ini (self-hosted atau Railway) */
  relayUrl?: string
  /** Versi format contact card */
  version: 1
}

// ─────────────────────────────────────────────────────────────────
// LAN DISCOVERY — data yang di-broadcast via mDNS
// ─────────────────────────────────────────────────────────────────

export interface LANPeerInfo {
  userId: string
  displayName: string
  publicKey: string
  host: string
  port: number
}

// ─────────────────────────────────────────────────────────────────
// EVENTS — event internal ConnectionManager
// ─────────────────────────────────────────────────────────────────

export interface ConnectionStateChangeEvent {
  mode: TransportMode
  previousMode: TransportMode | null
}

export interface MessageDeliveryEvent {
  messageId: string
  status: MessageStatus
  transport: TransportMode
}

// ─────────────────────────────────────────────────────────────────
// CALL SIGNALING — WebRTC 1-on-1 call
// ─────────────────────────────────────────────────────────────────

export type CallType = 'audio' | 'video'
export type CallSignalType = 'offer' | 'answer' | 'ice-candidate' | 'reject' | 'end'

export interface CallIceCandidate {
  candidate: string
  sdpMid: string | null
  sdpMLineIndex: number | null
}

/** Payload yang dikirim via relay untuk WebRTC call signaling */
export interface CallSignalPayload {
  callId: string
  fromUserId: string
  toUserId: string
  type: CallSignalType
  /** Tipe panggilan — hanya ada pada 'offer' */
  callType?: CallType
  /** SDP string — ada pada 'offer' dan 'answer' */
  sdp?: string
  /** ICE candidate — ada pada 'ice-candidate' */
  candidate?: CallIceCandidate
}
