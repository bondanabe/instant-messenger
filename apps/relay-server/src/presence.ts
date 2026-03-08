import type { Socket } from 'socket.io'

export interface UserPresence {
  readonly socket: Socket
  readonly userId: string
  readonly publicKey: string
  readonly deviceId: string
  readonly connectedAt: number
}

export function createPresenceService() {
  // In-memory only — tidak ada database, hilang saat server restart
  // Ini adalah by design: server hanya tahu siapa yang SEDANG online
  const users = new Map<string, UserPresence>()

  // PreKey bundles — public keys saja, tidak sensitif
  // Disimpan saat user connect, digunakan saat kontak ingin kirim pesan pertama
  const prekeys = new Map<string, unknown>()

  return {
    register(userId: string, socket: Socket, publicKey: string, deviceId: string): void {
      users.set(userId, {
        socket,
        userId,
        publicKey,
        deviceId,
        connectedAt: Date.now(),
      })
    },

    /** Hapus user berdasarkan socketId, return userId yang dihapus */
    unregisterBySocket(socketId: string): string | null {
      for (const [userId, presence] of users) {
        if (presence.socket.id === socketId) {
          users.delete(userId)
          return userId
        }
      }
      return null
    },

    getSocket(userId: string): Socket | null {
      return users.get(userId)?.socket ?? null
    },

    isOnline(userId: string): boolean {
      return users.has(userId)
    },

    getOnlineCount(): number {
      return users.size
    },

    // ── PreKey Bundle ──────────────────────────────────────────────

    /** Simpan prekey bundle user (hanya public keys, aman di-cache in-memory) */
    publishPreKey(userId: string, bundle: unknown): void {
      prekeys.set(userId, bundle)
    },

    /** Ambil prekey bundle user, atau null jika belum dipublikasikan */
    getPreKey(userId: string): unknown | null {
      return prekeys.get(userId) ?? null
    },
  }
}

export type PresenceService = ReturnType<typeof createPresenceService>
