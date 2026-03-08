import type { Server, Socket } from 'socket.io'
import type { PresenceService } from './presence.js'

// ─────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────
const MAX_PAYLOAD_BYTES = 64 * 1024       // 64KB per pesan
const MAX_USERID_LENGTH = 128
const MAX_PUBKEY_LENGTH = 256
const RATE_LIMIT_WINDOW_MS = 1_000        // 1 detik
const RATE_LIMIT_MAX_MSGS = 30            // 30 pesan/detik per koneksi

// ─────────────────────────────────────────────────────────────────
// TYPES — input dari client (divalidasi sebelum diproses)
// ─────────────────────────────────────────────────────────────────
interface RegisterPayload {
  userId: string
  publicKey: string
  deviceId: string
}

interface MessagePayload {
  targetUserId: string
  messageId: string
  /** Ciphertext base64 — server tidak membaca isi, hanya meneruskan */
  encryptedPayload: string
}

interface TypingPayload {
  targetUserId: string
  isTyping: boolean
}

interface ReadReceiptPayload {
  targetUserId: string
  messageId: string
}

type AckFn = (res: { ok?: boolean; error?: string; delivered?: boolean; reason?: string; bundle?: unknown }) => void

// ─────────────────────────────────────────────────────────────────
// LOGGING — structured, tanpa konten pesan (privasi)
// ─────────────────────────────────────────────────────────────────
function log(socketId: string, event: string, extra?: Record<string, unknown>): void {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    socketId: socketId.slice(0, 8), // Potong untuk keamanan
    event,
    ...extra,
  }
  console.log(JSON.stringify(entry))
}


export function createMessageGateway(io: Server, presence: PresenceService): void {
  // Rate limiter per koneksi socket (in-memory)
  const rateLimits = new Map<string, { count: number; resetAt: number }>()

  function isRateLimited(socketId: string): boolean {
    const now = Date.now()
    const entry = rateLimits.get(socketId)

    if (!entry || now > entry.resetAt) {
      rateLimits.set(socketId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
      return false
    }

    if (entry.count >= RATE_LIMIT_MAX_MSGS) return true
    entry.count++
    return false
  }

  function isValidString(val: unknown, maxLen: number): val is string {
    return typeof val === 'string' && val.length > 0 && val.length <= maxLen
  }

  // ───────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    let registeredUserId: string | null = null
    log(socket.id, 'connect')

    // ── 1. REGISTER ──────────────────────────────
    // Client memperkenalkan diri saat connect
    socket.on('register', (payload: unknown, ack?: AckFn) => {
      const p = payload as RegisterPayload
      if (
        !isValidString(p?.userId, MAX_USERID_LENGTH) ||
        !isValidString(p?.publicKey, MAX_PUBKEY_LENGTH) ||
        !isValidString(p?.deviceId, 128)
      ) {
        ack?.({ error: 'invalid_payload' })
        return
      }

      registeredUserId = p.userId
      presence.register(p.userId, socket, p.publicKey, p.deviceId)
      log(socket.id, 'register', { ok: true })
      ack?.({ ok: true })
    })

    // ── 2. MESSAGE ───────────────────────────────
    // Terima pesan terenkripsi → forward ke target → lupakan
    socket.on('message', (payload: unknown, ack?: AckFn) => {
      if (!registeredUserId) {
        ack?.({ error: 'not_registered' })
        return
      }

      if (isRateLimited(socket.id)) {
        log(socket.id, 'message', { result: 'rate_limited' })
        ack?.({ error: 'rate_limited' })
        return
      }

      const p = payload as MessagePayload
      if (
        !isValidString(p?.targetUserId, MAX_USERID_LENGTH) ||
        !isValidString(p?.messageId, 128) ||
        !isValidString(p?.encryptedPayload, MAX_PAYLOAD_BYTES * 2) // base64 overhead
      ) {
        ack?.({ error: 'invalid_payload' })
        return
      }

      // Cek ukuran payload setelah base64 decode estimate
      if (p.encryptedPayload.length > MAX_PAYLOAD_BYTES * 1.4) {
        ack?.({ error: 'payload_too_large' })
        return
      }

      const targetSocket = presence.getSocket(p.targetUserId)

      if (targetSocket) {
        // ✅ Target online → forward langsung
        // Server tidak menyimpan, tidak membaca isi pesan
        targetSocket.emit('message', {
          fromUserId: registeredUserId,
          messageId: p.messageId,
          encryptedPayload: p.encryptedPayload,
        })
        log(socket.id, 'message', { result: 'delivered' })
        ack?.({ ok: true, delivered: true })
      } else {
        // ⏳ Target offline → beritahu pengirim untuk simpan ke outbox lokal
        log(socket.id, 'message', { result: 'offline' })
        ack?.({ ok: true, delivered: false, reason: 'target_offline' })
      }
    })

    // ── 3. TYPING INDICATOR ──────────────────────
    // Ephemeral — tidak disimpan
    socket.on('typing', (payload: unknown) => {
      if (!registeredUserId) return
      const p = payload as TypingPayload
      if (!isValidString(p?.targetUserId, MAX_USERID_LENGTH)) return

      const targetSocket = presence.getSocket(p.targetUserId)
      targetSocket?.emit('typing', {
        fromUserId: registeredUserId,
        isTyping: Boolean(p.isTyping),
      })
    })

    // ── 4. READ RECEIPT ──────────────────────────
    // Ephemeral — tidak disimpan
    socket.on('read_receipt', (payload: unknown) => {
      if (!registeredUserId) return
      const p = payload as ReadReceiptPayload
      if (
        !isValidString(p?.targetUserId, MAX_USERID_LENGTH) ||
        !isValidString(p?.messageId, 128)
      )
        return

      const targetSocket = presence.getSocket(p.targetUserId)
      targetSocket?.emit('read_receipt', {
        fromUserId: registeredUserId,
        messageId: p.messageId,
      })
    })

    // ── 5. CHECK ONLINE ──────────────────────────
    // Cek apakah user lain sedang online
    socket.on('check_online', (payload: unknown, ack?: AckFn) => {
      if (!registeredUserId) return
      const p = payload as { targetUserId: string }
      if (!isValidString(p?.targetUserId, MAX_USERID_LENGTH)) return
      ack?.({ ok: true, delivered: presence.isOnline(p.targetUserId) })
    })

    // ── 6. PREKEY:PUBLISH ────────────────────────
    // Client mempublikasikan PreKey bundle-nya (semua public keys — tidak sensitif)
    // Disimpan in-memory, digunakan oleh kontak untuk inisiasi sesi X3DH
    socket.on('prekey:publish', (payload: unknown, ack?: AckFn) => {
      if (!registeredUserId) {
        ack?.({ error: 'not_registered' })
        return
      }
      const p = payload as Record<string, unknown>
      if (
        typeof p?.userId !== 'string' ||
        typeof p?.signedPreKey !== 'string' ||
        typeof p?.identityKey !== 'string'
      ) {
        ack?.({ error: 'invalid_payload' })
        return
      }
      // Pastikan userId di bundle sesuai dengan userId yang terdaftar (anti-spoofing)
      if (p.userId !== registeredUserId) {
        ack?.({ error: 'user_id_mismatch' })
        return
      }
      presence.publishPreKey(registeredUserId, payload)
      ack?.({ ok: true })
    })

    // ── 7. PREKEY:FETCH ──────────────────────────
    // Client meminta PreKey bundle milik user lain
    socket.on('prekey:fetch', (payload: unknown, ack?: AckFn) => {
      if (!registeredUserId) {
        ack?.({ error: 'not_registered' })
        return
      }
      const p = payload as { targetUserId?: string }
      if (!isValidString(p?.targetUserId, MAX_USERID_LENGTH)) {
        ack?.({ error: 'invalid_payload' })
        return
      }
      const bundle = presence.getPreKey(p.targetUserId!)
      if (bundle) {
        ack?.({ ok: true, bundle })
      } else {
        ack?.({ error: 'prekey_not_found' })
      }
    })

    // ── 8. CALL SIGNALING ────────────────────────
    // Ephemeral WebRTC signaling — server tidak menyimpan, hanya forward
    socket.on('call:signal', (payload: unknown) => {
      if (!registeredUserId) return
      const p = payload as {
        toUserId?: string
        callId?: string
        type?: string
        callType?: string
        sdp?: string
        candidate?: unknown
      }
      if (
        !isValidString(p?.toUserId, MAX_USERID_LENGTH) ||
        !isValidString(p?.callId, 128) ||
        !isValidString(p?.type, 32)
      )
        return

      const targetSocket = presence.getSocket(p.toUserId!)
      targetSocket?.emit('call:signal', {
        callId: p.callId,
        fromUserId: registeredUserId,
        toUserId: p.toUserId,
        type: p.type,
        ...(p.callType !== undefined && { callType: p.callType }),
        ...(typeof p.sdp === 'string' && { sdp: p.sdp }),
        ...(p.candidate !== undefined && { candidate: p.candidate }),
      })
    })

    // ── 9. DISCONNECT ────────────────────────────
    socket.on('disconnect', (reason) => {
      if (registeredUserId) {
        presence.unregisterBySocket(socket.id)
        rateLimits.delete(socket.id)
        registeredUserId = null
      }
      log(socket.id, 'disconnect', { reason })
    })
  })
}
