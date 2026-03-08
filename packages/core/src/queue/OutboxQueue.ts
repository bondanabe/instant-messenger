// ─────────────────────────────────────────────────────────────────
// OUTBOX RETRY STRATEGY
// Exponential backoff untuk pengiriman ulang pesan yang gagal
// ─────────────────────────────────────────────────────────────────

export interface OutboxEntry {
  id: string
  messageId: string
  targetUserId: string
  encryptedPayload: Uint8Array
  retryCount: number
  nextRetryAt: number
  createdAt: number
}

/**
 * Hitung waktu retry berikutnya (exponential backoff + jitter)
 * Retry 0 → 5 detik
 * Retry 1 → 10 detik
 * Retry 2 → 20 detik
 * Retry 3 → 40 detik
 * dst... hingga max 1 jam
 */
export function calculateNextRetry(retryCount: number): number {
  const BASE_MS = 5_000
  const MAX_MS = 3_600_000 // 1 jam
  const delay = Math.min(BASE_MS * Math.pow(2, retryCount), MAX_MS)
  // Tambahkan jitter ±20% untuk menghindari thundering herd
  const jitter = delay * 0.2 * (Math.random() * 2 - 1)
  return Date.now() + delay + jitter
}

/** Maksimal retry sebelum pesan ditandai 'failed' */
export const MAX_RETRY_COUNT = 10

/** Cek apakah entry sudah kedaluwarsa (lebih dari 7 hari) */
export function isOutboxExpired(entry: OutboxEntry): boolean {
  const EXPIRY_MS = 7 * 24 * 3_600_000 // 7 hari
  return Date.now() - entry.createdAt > EXPIRY_MS
}
