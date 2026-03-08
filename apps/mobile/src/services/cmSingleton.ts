import { MobileConnectionManager } from './ConnectionManager'
import type { WireMessage } from '@im/core'

// ─────────────────────────────────────────────────────────────────
// SINGLETON — satu instance ConnectionManager untuk seluruh app
// Dibuat saat setup selesai, dipakai oleh semua screen
// ─────────────────────────────────────────────────────────────────

let _cm: MobileConnectionManager | null = null

export interface CMConfig {
  userId: string
  displayName: string
  publicKey: string
  deviceId: string
  relayUrl: string
}

/**
 * Inisialisasi dan start ConnectionManager.
 * Dipanggil satu kali setelah identitas tersedia di App.tsx.
 */
export async function startConnectionManager(config: CMConfig): Promise<MobileConnectionManager> {
  if (_cm) {
    await _cm.stop()
  }

  _cm = new MobileConnectionManager(
    config.userId,
    config.displayName,
    config.publicKey,
    config.deviceId,
    config.relayUrl,
  )

  await _cm.start()
  return _cm
}

/**
 * Ambil singleton CM. Throws jika belum diinisialisasi.
 */
export function getConnectionManager(): MobileConnectionManager {
  if (!_cm) throw new Error('ConnectionManager belum diinisialisasi')
  return _cm
}

/**
 * Hentikan dan bersihkan CM. Dipanggil saat app unmount.
 */
export async function stopConnectionManager(): Promise<void> {
  if (_cm) {
    await _cm.stop()
    _cm = null
  }
}
