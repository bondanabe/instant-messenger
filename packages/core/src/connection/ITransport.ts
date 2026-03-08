import type { TransportMode, WireMessage, MessageDeliveryEvent } from '../protocol/types.js'

// ─────────────────────────────────────────────────────────────────
// ITRANSPORT — interface yang harus diimplementasikan setiap transport
// ─────────────────────────────────────────────────────────────────

export interface ITransport {
  readonly mode: TransportMode

  /** Cek apakah transport ini tersedia saat ini */
  isAvailable(): Promise<boolean>

  /**
   * Sambungkan ke transport
   * @param onMessage callback saat pesan masuk
   */
  connect(onMessage: (msg: WireMessage, fromUserId: string) => void): Promise<void>

  /** Kirim pesan ke target userId */
  send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent>

  /** Putuskan koneksi */
  disconnect(): Promise<void>
}

// ─────────────────────────────────────────────────────────────────
// ICONNECTION MANAGER — interface utama untuk semua platform
// ─────────────────────────────────────────────────────────────────

export interface IConnectionManager {
  /** Mode koneksi yang aktif saat ini */
  readonly currentMode: TransportMode

  /**
   * Kirim pesan — Connection Manager akan memilih transport terbaik
   * dan menyimpan ke outbox jika semua transport gagal
   */
  send(targetUserId: string, message: WireMessage): Promise<MessageDeliveryEvent>

  /** Mulai monitoring jaringan (switching otomatis) */
  start(): Promise<void>

  /** Hentikan semua koneksi */
  stop(): Promise<void>

  /** Subscribe ke perubahan mode koneksi */
  onModeChange(handler: (mode: TransportMode) => void): () => void

  /** Subscribe ke pesan masuk */
  onMessage(handler: (msg: WireMessage, fromUserId: string) => void): () => void
}
